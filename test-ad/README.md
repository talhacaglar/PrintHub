# Test Active Directory (Samba AD DC)

PrintHub'ın Active Directory özelliklerini şirket AD'sine erişmeden denemek ve
AD öğrenmek için, bilgisayarınızda Docker içinde çalışan **gerçek bir Domain Controller**.

Samba'nın AD DC modu, Windows Server'ın Active Directory'siyle **aynı protokolleri**
konuşur (LDAP, Kerberos, aynı şema: `sAMAccountName`, `memberOf`, `objectCategory`).
Yani burada öğrendiğiniz her şey şirketin gerçek AD'sinde birebir geçerlidir.

> ⚠️ **Sadece test/geliştirme içindir.** Şifresiz (TLS'siz) LDAP bağlantısına izin
> verecek şekilde ayarlıdır (`ldap server require strong auth = no`) ve parolalar
> bu dosyada açıkça yazılıdır. Üretimde asla böyle yapılmaz — orada `ldaps://` (636) kullanılır.

## Kurulum / çalıştırma

```bash
# İmajı derle (ilk sefer, ~1 dk)
docker build -t printhub-testad:latest test-ad/

# Domain Controller'ı başlat
docker run -d --name printhub-testad --hostname dc1 \
  -p 127.0.0.1:389:389 -p 127.0.0.1:636:636 \
  -v printhub_ad_lib:/var/lib/samba -v printhub_ad_etc:/etc/samba \
  --restart unless-stopped printhub-testad:latest

# İlk açılışta domain kurulur + örnek veri eklenir (~1 dk). Takip et:
docker logs -f printhub-testad
```

| Komut | Ne yapar |
|---|---|
| `docker stop printhub-testad` | DC'yi durdurur (veri durur, kaybolmaz) |
| `docker start printhub-testad` | Tekrar başlatır |
| `docker rm -f printhub-testad && docker volume rm printhub_ad_lib printhub_ad_etc` | **Her şeyi siler**, sıfırdan kurmak için |

## PrintHub bağlantı ayarları

Ayarlar → Active Directory Bağlantısı:

| Alan | Değer |
|---|---|
| Sunucu adresi | `ldap://127.0.0.1:389` |
| Base DN | `DC=printhub,DC=local` |
| Bağlantı hesabı | `printhub@printhub.local` |
| Parola | `Printhub2026!` |

`printhub` hesabı **sıradan bir kullanıcıdır, yönetici değildir** — AD'yi yalnızca okur.
Gerçek hayatta da IT'den tam olarak böyle bir "servis hesabı" istemelisiniz
(en az ayrıcalık ilkesi, ISO 27001 A.5.15).

Domain yöneticisi ise: `Administrator@printhub.local` / `Printhub2026!`

## İçindeki örnek veri

**Kullanıcılar** (hepsinin parolası `Test1234`):

| Kullanıcı | Ad | Departman | Unvan |
|---|---|---|---|
| `ahmet.yilmaz` | Ahmet Yilmaz | Muhasebe | Muhasebe Uzmanı |
| `ayse.demir` | Ayse Demir | Muhasebe | Muhasebe Müdürü |
| `mehmet.kaya` | Mehmet Kaya | Bilgi Islem | Sistem Yöneticisi |
| `zeynep.sahin` | Zeynep Sahin | Bilgi Islem | Stajyer |
| `can.ozturk` | Can Ozturk | Satis | Satış Temsilcisi |

**Gruplar:** `Muhasebe-Okuma`, `Muhasebe-Yazma`, `BilgiIslem-Yoneticiler`,
`Ortak-Klasor-Okuma`, `Yazici-Yoneticileri`

Gerçek hayatta klasör yetkileri **kişiye değil gruba** verilir; kişi gruba üye
yapılır. PrintHub da bu yüzden kullanıcının `memberOf` (üye olduğu gruplar)
listesini okuyup klasör izinleriyle eşleştirir.

## AD'yi kurcalamak (öğrenmek için en iyi yol)

Konteynerin içine girin:

```bash
docker exec -it printhub-testad bash
```

Sonra `samba-tool` ile — bu komutlar gerçek AD'deki "Active Directory Users and
Computers" ekranının komut satırı karşılığıdır:

```bash
samba-tool user list                          # kullanıcıları listele
samba-tool user show ayse.demir               # bir kullanıcının tüm alanları
samba-tool group list                         # grupları listele
samba-tool group listmembers Muhasebe-Okuma   # grubun üyeleri

# Yeni kullanıcı
samba-tool user create deneme.kullanici Test1234 \
  --given-name=Deneme --surname=Kullanici --department="Satis"

# Gruba üye ekle / çıkar
samba-tool group addmembers Muhasebe-Okuma deneme.kullanici
samba-tool group removemembers Muhasebe-Okuma deneme.kullanici

# Hesabı devre dışı bırak (PrintHub listesinden düşer)
samba-tool user disable deneme.kullanici
```

Değişiklikten sonra PrintHub'da Active Directory sayfasını yenileyin — anında görürsünüz.

LDAP'ı ham haliyle görmek isterseniz (PrintHub'ın attığı sorgunun aynısı):

```bash
docker exec -it printhub-testad ldapsearch -x -H ldap://localhost \
  -D "printhub@printhub.local" -w 'Printhub2026!' \
  -b "DC=printhub,DC=local" "(sAMAccountName=ayse.demir)" memberOf department
```

## Kavramlar (kısa sözlük)

| Terim | Anlamı |
|---|---|
| **Domain** | Şirketin kullanıcı/bilgisayar dünyası. Burada: `printhub.local` |
| **Domain Controller (DC)** | Domain'i barındıran sunucu. Burada: konteyner (`dc1`) |
| **LDAP** | AD'ye soru sorma protokolü. PrintHub bunu kullanır |
| **DN** (Distinguished Name) | Bir nesnenin tam adresi: `CN=Ayse Demir,OU=Muhasebe,OU=Sirket,DC=printhub,DC=local` |
| **Base DN** | Aramanın başlayacağı kök: `DC=printhub,DC=local` |
| **OU** (Organizational Unit) | Klasör gibi düşünün; kullanıcıları departmana göre ayırır |
| **CN** (Common Name) | Nesnenin görünen adı |
| **sAMAccountName** | Kullanıcının giriş adı (`ayse.demir`) |
| **memberOf** | Kullanıcının üye olduğu gruplar |
| **Bind** | LDAP'a "giriş yapma" işlemi (kullanıcı + parola) |

## Gerçek AD'ye geçerken

Kod tarafında **hiçbir şey değişmez**. Sadece Ayarlar'daki dört alan değişir:

| Alan | Test | Gerçek |
|---|---|---|
| Sunucu | `ldap://127.0.0.1:389` | `ldaps://dc01.sirket.local:636` |
| Base DN | `DC=printhub,DC=local` | `DC=sirket,DC=local` |
| Hesap | `printhub@printhub.local` | IT'nin açtığı servis hesabı |

Ek olarak, ağ klasörü okuma/yazma yetkilerinin görünmesi için PrintHub'ın
**Windows üzerinde** çalışması gerekir (klasör izinleri PowerShell `Get-Acl` ile
okunuyor) ve Ayarlar'daki paylaşım kök yollarına `\\dosyasunucu\ortak` gibi
yolların girilmesi gerekir. Linux'ta kullanıcı/grup bilgileri gelir, klasör
izinleri bölümü "desteklenmiyor" der.
