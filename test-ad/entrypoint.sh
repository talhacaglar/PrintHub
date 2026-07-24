#!/bin/bash
# ============================================
# Samba AD DC'yi ilk açılışta kurar (provision), örnek kullanıcı/grupları
# ekler ve sonraki açılışlarda mevcut veriyle devam eder.
# ============================================
set -e

REALM="${AD_REALM:-PRINTHUB.LOCAL}"
DOMAIN="${AD_DOMAIN:-PRINTHUB}"
ADMIN_PASS="${AD_ADMIN_PASS:-Printhub2026!}"
SERVICE_USER="${AD_SERVICE_USER:-printhub}"
SERVICE_PASS="${AD_SERVICE_PASS:-Printhub2026!}"

if [ ! -f /var/lib/samba/private/sam.ldb ]; then
    echo "[test-ad] Domain kuruluyor: $REALM ..."
    rm -f /etc/samba/smb.conf

    # posix:eadb → NT ACL'leri dosya sistemi xattr'ı yerine tdb'de sakla.
    # Konteyner içinde security.* xattr yazma izni yok; bu Samba'nın
    # bu durum için önerdiği yol (--privileged gerekmesin diye).
    samba-tool domain provision \
        --realm="$REALM" \
        --domain="$DOMAIN" \
        --server-role=dc \
        --dns-backend=SAMBA_INTERNAL \
        --adminpass="$ADMIN_PASS" \
        --use-rfc2307 \
        --option="posix:eadb=/var/lib/samba/eadb.tdb"

    # Test ortamı: şifresiz (TLS'siz) LDAP simple bind'a izin ver.
    # ÜRETİMDE ASLA! Gerçek AD'de ldaps:// (636) kullanılır.
    grep -q 'ldap server require strong auth' /etc/samba/smb.conf || \
        sed -i '/^\[global\]/a\        ldap server require strong auth = no' /etc/samba/smb.conf
    grep -q 'posix:eadb' /etc/samba/smb.conf || \
        sed -i '/^\[global\]/a\        posix:eadb = /var/lib/samba/eadb.tdb' /etc/samba/smb.conf

    # Parola politikasını gevşet (test kullanıcıları kolay parola alsın)
    samba-tool domain passwordsettings set --complexity=off --min-pwd-length=6 --history-length=0 || true
    samba-tool domain passwordsettings set --max-pwd-age=0 || true

    touch /var/lib/samba/.needs-seed
fi

# Samba'yı arka planda başlat
samba -D

# LDAP açılana kadar bekle
for i in $(seq 1 30); do
    if ldapsearch -x -H ldap://localhost -b "" -s base > /dev/null 2>&1; then break; fi
    sleep 1
done

# --------------------------------------------
# Örnek veri (yalnızca ilk açılışta)
# --------------------------------------------
if [ -f /var/lib/samba/.needs-seed ]; then
    echo "[test-ad] Örnek kullanıcı ve gruplar ekleniyor..."

    BASE_DN=$(echo "$REALM" | awk -F. '{for(i=1;i<=NF;i++) printf "%sDC=%s", (i>1?",":""), tolower($i)}')

    # Organizational Unit'ler (AD'de kullanıcıları böyle gruplarsınız)
    samba-tool ou create "OU=Sirket,$BASE_DN" || true
    samba-tool ou create "OU=Muhasebe,OU=Sirket,$BASE_DN" || true
    samba-tool ou create "OU=BilgiIslem,OU=Sirket,$BASE_DN" || true

    # Güvenlik grupları — klasör yetkileri gerçek hayatta bunlara verilir
    samba-tool group add "Muhasebe-Okuma" || true
    samba-tool group add "Muhasebe-Yazma" || true
    samba-tool group add "BilgiIslem-Yoneticiler" || true
    samba-tool group add "Ortak-Klasor-Okuma" || true
    samba-tool group add "Yazici-Yoneticileri" || true

    # user create: sam / parola / ad / soyad / e-posta / departman / unvan
    add_user() {
        local sam="$1" pass="$2" given="$3" sur="$4" mail="$5" dept="$6" title="$7" ou="$8"
        samba-tool user create "$sam" "$pass" \
            --given-name="$given" --surname="$sur" \
            --mail-address="$mail" --department="$dept" --job-title="$title" \
            --userou="$ou" || return 0
        # displayName'i elle set et (AD'de "Görünen Ad" alanı)
        cat > /tmp/dn.ldif <<EOF
dn: CN=$given $sur,$ou,$BASE_DN
changetype: modify
replace: displayName
displayName: $given $sur
EOF
        ldbmodify -H /var/lib/samba/private/sam.ldb /tmp/dn.ldif > /dev/null 2>&1 || true
    }

    add_user "ahmet.yilmaz"  "Test1234" "Ahmet"  "Yilmaz"  "ahmet.yilmaz@printhub.local"  "Muhasebe"     "Muhasebe Uzmani"     "OU=Muhasebe,OU=Sirket"
    add_user "ayse.demir"    "Test1234" "Ayse"   "Demir"   "ayse.demir@printhub.local"    "Muhasebe"     "Muhasebe Muduru"     "OU=Muhasebe,OU=Sirket"
    add_user "mehmet.kaya"   "Test1234" "Mehmet" "Kaya"    "mehmet.kaya@printhub.local"   "Bilgi Islem"  "Sistem Yoneticisi"   "OU=BilgiIslem,OU=Sirket"
    add_user "zeynep.sahin"  "Test1234" "Zeynep" "Sahin"   "zeynep.sahin@printhub.local"  "Bilgi Islem"  "Stajyer"             "OU=BilgiIslem,OU=Sirket"
    add_user "can.ozturk"    "Test1234" "Can"    "Ozturk"  "can.ozturk@printhub.local"    "Satis"        "Satis Temsilcisi"    "OU=Sirket"

    # Grup üyelikleri (PrintHub bunları memberOf ile okuyor)
    samba-tool group addmembers "Muhasebe-Okuma"        "ahmet.yilmaz,ayse.demir"   || true
    samba-tool group addmembers "Muhasebe-Yazma"        "ayse.demir"                || true
    samba-tool group addmembers "BilgiIslem-Yoneticiler" "mehmet.kaya"              || true
    samba-tool group addmembers "Yazici-Yoneticileri"   "mehmet.kaya,zeynep.sahin"  || true
    samba-tool group addmembers "Ortak-Klasor-Okuma"    "ahmet.yilmaz,ayse.demir,mehmet.kaya,zeynep.sahin,can.ozturk" || true

    # PrintHub'ın AD'ye bağlanacağı SERVİS HESABI — sadece okuma yapar,
    # yönetici değildir (en az ayrıcalık ilkesi / ISO 27001 A.5.15).
    samba-tool user create "$SERVICE_USER" "$SERVICE_PASS" \
        --description="PrintHub LDAP okuma servis hesabi" || true
    samba-tool user setexpiry "$SERVICE_USER" --noexpiry || true

    rm -f /var/lib/samba/.needs-seed /tmp/dn.ldif
    echo "[test-ad] Örnek veri hazır."
fi

echo "[test-ad] ================================================"
echo "[test-ad]  Domain    : $REALM"
echo "[test-ad]  LDAP      : ldap://127.0.0.1:389"
echo "[test-ad]  Base DN   : $(echo "$REALM" | awk -F. '{for(i=1;i<=NF;i++) printf "%sDC=%s", (i>1?",":""), tolower($i)}')"
echo "[test-ad]  Servis hs.: $SERVICE_USER@$(echo "$REALM" | tr 'A-Z' 'a-z')  /  $SERVICE_PASS"
echo "[test-ad] ================================================"

# Samba'yı ön planda tut (konteyner ayakta kalsın)
tail -f /var/log/samba/log.samba 2>/dev/null || sleep infinity
