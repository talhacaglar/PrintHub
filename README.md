# PrintHub

[English](#english) · [Türkçe](#türkçe)

## English

A desktop workspace for network printer monitoring, toner stock and costs, and Active Directory operations. Built with Electron, Express and SQLite.

### Features

- SNMP v2c/v3 discovery, printer readings and consumable tracking.
- Toner inventory, cost calculations, exports and operational reports.
- LDAP directory access, role-based permissions and audit records.
- ISO/IEC 27001-oriented evidence and reports; Windows-specific share permissions and optional WinRM inventory.

### Getting started

Install dependencies, then start Electron. The backend listens on `127.0.0.1`. On a fresh setup, sign in with `admin` / `admin123` and complete the required password change.

```bash
git clone https://github.com/talhacaglar/PrintHub.git
cd PrintHub
npm install
npm start
```

Configure network ranges, SNMP and LDAP in Settings. If a native SQLite ABI mismatch occurs, run `npm run rebuild:clean`. Run `npm test` for the repository tests. A separate Samba AD test environment is documented in [test-ad/README.md](test-ad/README.md). Reporting support does not itself constitute ISO certification.

[Detailed technical reference](REFERENCE.md)

## Türkçe

Ağ yazıcısı izleme, toner stoğu ve maliyetleri ile Active Directory işlemlerini birleştiren masaüstü çalışma alanı. Electron, Express ve SQLite ile geliştirilmiştir.

### Özellikler

- SNMP v2c/v3 keşif, yazıcı ölçümleri ve sarf malzemesi takibi.
- Toner envanteri, maliyet hesaplama, dışa aktarma ve operasyon raporları.
- LDAP dizin erişimi, rol tabanlı yetkiler ve denetim kayıtları.
- ISO/IEC 27001 odaklı kanıt ve raporlar; Windows’a özel paylaşım yetkileri ve isteğe bağlı WinRM envanteri.

### Başlangıç

Bağımlılıkları kurup Electron uygulamasını başlatın. Backend `127.0.0.1` üzerinde dinler. İlk kurulumda `admin` / `admin123` ile giriş yapıp zorunlu parola değişikliğini tamamlayın.

```bash
git clone https://github.com/talhacaglar/PrintHub.git
cd PrintHub
npm install
npm start
```

Ağ aralıklarını, SNMP ve LDAP bilgilerini Ayarlar bölümünde tanımlayın. Yerel SQLite ABI uyuşmazlığında `npm run rebuild:clean` çalıştırın. Depo testleri için `npm test` kullanın. Ayrı Samba AD test ortamı [test-ad/README.md](test-ad/README.md) içinde açıklanır. Raporlama desteği tek başına ISO sertifikasyonu anlamına gelmez.

[Ayrıntılı teknik referans](REFERENCE.md)
