# PrintHub

Ağ yazıcılarını SNMP ile keşfeden ve izleyen; toner maliyeti, stok yönetimi, Active Directory erişim görünümü ve ISO/IEC 27001 uyumlu denetim özellikleri sunan bir **BT varlık & erişim yönetim** masaüstü uygulaması.

Electron + Express + SQLite ile geliştirilmiştir.

---

## Özellikler

- **Ağ Keşfi** — Belirtilen IP aralığında (`/22`, `/24`) yazıcı portlarını (9100/631/515) tarar, bulunan cihazları SNMP (RFC 3805 / MIB-II / HOST-RESOURCES) ile sorgular.
- **Yazıcı İzleme** — Toner/mürekkep seviyeleri, kağıt tepsileri, sayfa sayacı, durum ve düşük toner/kağıt bildirimleri.
- **Toner Maliyeti & Tüketim** — Toner tür bilgisi, birim maliyet, aylık basılan sayfa, yazıcı bazlı tüketim ve tahmini kartuş değişim sayısı (sayaç geçmişinden hesaplanır).
- **Stok Yönetimi** — Toner türleri, stoğa giriş/çıkış hareketleri, mevcut seviye ve düşük stok uyarıları (bildirim paneline düşer).
- **Active Directory** — Gerçek LDAP bağlantısı; kullanıcıya tıklandığında grup üyelikleri, ağ klasörü okuma/yazma yetkileri ve kullanılan kaynaklar.
- **ISO 27001 / Güvenlik** — Rol tabanlı erişim (RBAC), denetim kaydı (audit log, arama/filtre), erişim hakları raporu ve kullanıcı yönetimi.
- **Açık / Karanlık Tema** — Üst bardaki düğmeyle geçiş; tercih kalıcıdır. Minimalist, sade arayüz.
- **CSV Dışa Aktarma** — Stok hareketleri, denetim kaydı, maliyet ve tüketim tabloları tek tıkla CSV (Excel uyumlu, UTF-8 BOM).
- **Varlık Envanteri Alanları** — Yazıcılara demirbaş no, özel konum ve not eklenebilir (ISO A.5.9).
- **Otomatik Periyodik Yenileme** — Ayarlanan aralıkta yazıcılar arka planda sorgulanır; tüketim zaman serisi otomatik beslenir.

## ISO/IEC 27001:2022 Kontrol Eşlemesi

| Kontrol | Alan | Uygulama |
|---|---|---|
| A.5.9 | Varlık envanteri | Yazıcı keşfi + toner stok envanteri |
| A.5.15 / A.5.18 | Erişim kontrolü & hakları | RBAC + AD klasör yetkileri görünümü |
| A.8.15 | Loglama | Tüm oluştur/güncelle/sil ve giriş olayları denetim kaydında |
| A.8.16 | İzleme | Düşük stok/toner ve başarısız giriş uyarıları |
| A.5.17 / A.8.5 | Kimlik doğrulama | bcrypt parola hash + zorunlu giriş |

---

## Kurulum

Gereksinim: **Node.js 18+**

```bash
npm install
```

> `better-sqlite3` yerel (native) bir modüldür ve `postinstall` adımında Electron ABI'sine göre otomatik derlenir. Manuel gerektiğinde: `npm run rebuild`.

## Çalıştırma

```bash
npm start
```

Uygulama açılışında giriş ekranı gelir.

**Varsayılan yönetici:** kullanıcı `admin` / parola `admin123` — ilk girişte parola değiştirmeniz istenir.

## Yapılandırma

Ayarlar sayfasından:

- **Ağ Tarama** — Base IP, CIDR maskesi, para birimi.
- **Active Directory** — LDAP URL (`ldap://dc.sirket.local`), Base DN, servis hesabı (Bind DN + parola) ve paylaşım kök yolları.

> **Ağ klasörü okuma/yazma yetkileri** yalnızca Windows üzerinde (PowerShell `Get-Acl` ile dosya sunucusundan) çözümlenir. Diğer işletim sistemlerinde bu bölüm bilgilendirme notu gösterir, uygulama çalışmaya devam eder.

## Paketleme

```bash
npm run build:win     # Windows (NSIS installer)
npm run build:linux   # Linux
```

---

## Roller

| Rol | Yetki |
|---|---|
| `viewer` | Salt okuma (paneller, raporlar, AD görünümü) |
| `operator` | + Tarama, stok giriş/çıkış, toner türü yönetimi |
| `admin` | + Kullanıcı yönetimi, ayarlar, denetim kaydı, AD yapılandırması |

## Mimari

| Dosya | Sorumluluk |
|---|---|
| `main.js` | Electron ana süreç; Express sunucusunu başlatır, DB yolunu `userData` altına ayarlar |
| `server.js` | Express API uçları + oturum/RBAC yönlendirmesi |
| `scanner.js` | TCP port taraması ile yazıcı keşfi |
| `snmp-query.js` | SNMP ile yazıcı bilgisi çekme |
| `db.js` | SQLite şema, migration, denetim kaydı |
| `auth.js` | Kimlik doğrulama, oturum, RBAC, kullanıcı yönetimi |
| `readings.js` | Yazıcı okuma geçmişi + toner tüketim hesabı |
| `ad.js` | Active Directory / LDAP + klasör ACL çözümleme |
| `index.html`, `js/*.js`, `style.css` | Arayüz (core / printers-ui / settings-ui / pages-ui / ad-ui modülleri) |

## Veri Saklama

Tüm kalıcı veri (kullanıcılar, stok, ayarlar, denetim kaydı, yazıcı okumaları) Electron'un kullanıcı verisi klasöründeki `printhub.db` (SQLite) dosyasında tutulur. Bu dosya sürüm kontrolüne dahil **edilmez**.

## Lisans

[ISC](LICENSE)
