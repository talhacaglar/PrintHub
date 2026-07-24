<div align="center">

# 🖨️ PrintHub

**Ağ yazıcıları, toner stoğu ve Active Directory erişimi için tek panel.**

Electron masaüstü uygulaması — SNMP ile yazıcı keşfi/izleme, toner maliyeti & stok
yönetimi, gerçek LDAP tabanlı Active Directory görünümü ve ISO/IEC 27001 uyumlu
denetim kaydı bir arada. Electron + Express + SQLite ile geliştirilmiştir.

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![Electron](https://img.shields.io/badge/electron-%5E43-47848F?logo=electron&logoColor=white)](package.json)
[![ISO/IEC 27001](https://img.shields.io/badge/ISO%2FIEC-27001%3A2022-0d6efd)](#️-isoiec-270012022-kontrol-eşlemesi)

</div>

---

## 📑 İçindekiler

- [Özellikler](#-özellikler)
- [ISO/IEC 27001:2022 Kontrol Eşlemesi](#️-isoiec-270012022-kontrol-eşlemesi)
- [Kurulum](#-kurulum)
- [Çalıştırma](#️-çalıştırma)
- [Yapılandırma](#️-yapılandırma)
- [Test](#-test)
- [Paketleme](#-paketleme)
- [Roller](#-roller)
- [Mimari](#-mimari)
- [Güvenlik & Veri Saklama](#-güvenlik--veri-saklama)
- [Lisans](#-lisans)

---

## ✨ Özellikler

| | |
|---|---|
| 🔍 **Ağ Keşfi** | Belirtilen IP aralığında (`/22`, `/24`) yazıcı portlarını (9100/631/515) tarar; bulunanlar DB'ye kaydedilir ve uygulama yeniden açıldığında tarama beklemeden otomatik yüklenip arka planda sorgulanır. |
| 📊 **Yazıcı İzleme** | Toner/mürekkep seviyeleri, kağıt tepsileri, sayfa sayacı, durum ve düşük toner/kağıt bildirimleri — SNMP v2c veya v3 (auth/priv) ile. |
| 💰 **Toner Maliyeti & Tüketim** | Toner tür bilgisi, birim maliyet, aylık basılan sayfa, yazıcı bazlı tüketim ve sayaç geçmişinden tahmini kartuş değişim sayısı. |
| 📦 **Stok Yönetimi** | Toner türleri, stoğa giriş/çıkış hareketleri (geriye dönük tarihli), mevcut seviye ve bildirim paneline düşen düşük stok uyarıları. |
| 🗂️ **Kişisel IT Envanteri** | Kullanıcıya atanmış cihazlar ve yüklü yazılımlar — AD (`Get-ADComputer`), WinRM (donanım/yazılım detayı) veya manuel giriş kaynaklı. |
| 🔐 **Active Directory** | Gerçek LDAP bağlantısı; kullanıcıya tıklandığında grup üyelikleri, ağ klasörü okuma/yazma yetkileri (Windows `Get-Acl`) ve kullanılan kaynaklar. |
| 🛡️ **ISO 27001 / Güvenlik** | Rol tabanlı erişim (RBAC), aranabilir/filtrelenebilir denetim kaydı, erişim hakları raporu, kullanıcı yönetimi ve zorunlu ilk parola değişimi. |
| 🌗 **Açık / Karanlık Tema** | Üst bardaki düğmeyle geçiş, tercih kalıcı; minimalist, sade arayüz. |
| 📤 **CSV Dışa Aktarma** | Stok hareketleri, denetim kaydı, maliyet ve tüketim tabloları tek tıkla CSV (Excel uyumlu, UTF-8 BOM). |
| 🏷️ **Varlık Envanteri Alanları** | Yazıcılara demirbaş no, özel konum ve not eklenebilir (ISO A.5.9). |
| ⏱️ **Otomatik Periyodik Yenileme** | Ayarlanan aralıkta yazıcılar arka planda sorgulanır; tüketim zaman serisi otomatik beslenir. |

## 🛡️ ISO/IEC 27001:2022 Kontrol Eşlemesi

| Kontrol | Alan | Uygulama |
|---|---|---|
| A.5.9 | Varlık envanteri | Yazıcı keşfi + toner stok envanteri + kişisel IT envanteri |
| A.5.15 / A.5.18 | Erişim kontrolü & hakları | RBAC + AD klasör yetkileri görünümü |
| A.8.15 | Loglama | Tüm oluştur/güncelle/sil ve giriş olayları denetim kaydında |
| A.8.16 | İzleme | Düşük stok/toner ve başarısız giriş uyarıları |
| A.5.17 / A.8.5 | Kimlik doğrulama | bcrypt parola hash + zorunlu giriş + zorunlu ilk parola değişimi |

---

## 🚀 Kurulum

Gereksinim: **Node.js 18+**

```bash
npm install
```

> `better-sqlite3` yerel (native) bir modüldür ve `postinstall` adımında Electron ABI'sine göre otomatik derlenir. Manuel gerektiğinde: `npm run rebuild`.

## ▶️ Çalıştırma

```bash
npm start
```

Uygulama açılışında giriş ekranı gelir. Sunucu yalnızca `127.0.0.1` üzerinden dinler; ağdan erişilemez.

**Varsayılan yönetici:** kullanıcı `admin` / parola `admin123` — ilk girişte parola değiştirmeniz istenir.

## ⚙️ Yapılandırma

Ayarlar sayfasından:

- **Ağ Tarama** — Base IP, CIDR maskesi, para birimi, otomatik yenileme aralığı.
- **SNMP** — v2c (community string) veya v3 (kullanıcı, auth/priv protokol ve anahtarları).
- **Active Directory** — LDAP URL (`ldap://dc.sirket.local`), Base DN, servis hesabı (Bind DN + parola), paylaşım kök yolları.
- **WinRM (opsiyonel)** — `winrm_enabled` açıldığında (yalnızca Windows) kişisel IT envanteri için uzak donanım/yazılım toplaması etkinleşir.

> **Ağ klasörü okuma/yazma yetkileri** ve **WinRM envanteri** yalnızca Windows üzerinde çözümlenir. Diğer işletim sistemlerinde bu bölümler bilgilendirme notu gösterir, uygulama çalışmaya devam eder.

### Active Directory'yi denemek için test ortamı

Şirket AD'nize dokunmadan gerçek bir LDAP/Kerberos sunucusuyla denemek isterseniz
`test-ad/` altında Docker tabanlı bir Samba AD DC bulunur. Kurulum adımları için
[`test-ad/README.md`](test-ad/README.md) dosyasına bakın.

## 🧪 Test

```bash
npm test
```

`test/` altındaki birim testleri (`node --test`) tarayıcı/AD yardımcı fonksiyonlarını ve
toner tüketim hesaplarını dış bağımlılık olmadan doğrular.

## 📦 Paketleme

```bash
npm run build:win     # Windows (NSIS installer)
npm run build:linux   # Linux
```

---

## 👤 Roller

| Rol | Yetki |
|---|---|
| `viewer` | Salt okuma (paneller, raporlar, AD görünümü) |
| `operator` | + Tarama, stok giriş/çıkış, toner türü yönetimi |
| `admin` | + Kullanıcı yönetimi, ayarlar, denetim kaydı, AD yapılandırması |

## 🧱 Mimari

| Dosya / Klasör | Sorumluluk |
|---|---|
| `main.js` | Electron ana süreç; Express sunucusunu başlatır, DB yolunu `userData` altına ayarlar |
| `server.js` | Express API uçları, oturum/RBAC yönlendirmesi, eşzamanlı SNMP sorgu havuzu |
| `scanner.js` | TCP port taraması ile yazıcı keşfi |
| `snmp-query.js` | SNMP (v2c/v3) ile yazıcı bilgisi çekme |
| `db.js` | SQLite şema, migration, şifreli ayar desteği, denetim kaydı |
| `auth.js` | Kimlik doğrulama, oturum, RBAC, kullanıcı yönetimi |
| `readings.js` | Yazıcı okuma geçmişi + toner tüketim hesabı |
| `ad.js` / `ad-utils.js` | Active Directory / LDAP + klasör ACL çözümleme + WinRM envanter toplama |
| `inventory.js` | Kullanıcı bazlı IT cihaz/yazılım envanteri (AD / WinRM / manuel) |
| `index.html`, `js/*.js`, `style.css` | Arayüz — `core` / `printers-ui` / `settings-ui` / `pages-ui` / `ad-ui` modülleri |
| `test/` | Birim testleri (`node --test`) |
| `test-ad/` | Docker tabanlı Samba AD DC test ortamı |
| `tools/probe-ad.js` | LDAP bağlantısını komut satırından hızlı doğrulama aracı |

## 🔒 Güvenlik & Veri Saklama

- Sunucu yalnızca `127.0.0.1`'e bağlanır (`server.js`); CORS yalnızca uygulamanın kendi origin'ine izin verir.
- LDAP servis hesabı parolası ve SNMPv3 anahtarları gibi sırlar `db.js` üzerinden şifreli olarak saklanır; eski düz metin değerler otomatik migrate edilir.
- İlk girişte ve yönetici tarafından sıfırlanan hesaplarda parola değiştirilmeden hiçbir işlem yapılamaz (zorunlu parola değişim kapısı).
- Tüm kalıcı veri (kullanıcılar, stok, ayarlar, denetim kaydı, yazıcı okumaları, envanter) Electron'un kullanıcı verisi klasöründeki `printhub.db` (SQLite) dosyasında tutulur. Bu dosya sürüm kontrolüne dahil **edilmez**.

## 📄 Lisans

[ISC](LICENSE)
