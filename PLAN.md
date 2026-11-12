# Bikorch Deck — Proje Planı

USB ile bilgisayara bağlı, yalnızca bu işe ayrılmış tablette tam ekran çalışan dokunmatik geliştirici analiz ekranı.

## Mimari

```
PC (Windows)                                    Tablet
┌──────────────────────────────┐   USB kablo   ┌─────────────────────────┐
│ Deck ajanı (Node, :8787)     │◄─────────────►│ Tam ekran tarayıcı / PWA │
│  ├ CPU / RAM      (Node os)  │  adb reverse  │  http://localhost:8787   │
│  ├ GPU            (nvidia-smi)│              │  ├ canlı akış (SSE)      │
│  ├ pencere/süreç/ağ/disk     │              │  └ dokunma → POST /api   │
│  │   (kalıcı PowerShell)     │              └─────────────────────────┘
│  └ Claude kullanımı          │
│      (~/.claude/projects)    │
└──────────────────────────────┘
```

- **Veri hep PC'den gelir.** Tablet yalnızca ekran ve dokunmatik yüzeydir.
- **Bağlantı yalnızca kablo üzerinden.** Ajan sadece `127.0.0.1` dinler; `adb reverse` tabletin `localhost:8787` adresini kablo üzerinden PC'ye bağlar. Wi-Fi'da hiçbir şey açılmaz.
- **Sıfır bağımlılık.** `npm install` gerekmez; Node + Windows'un kendi araçları yeter.
- Tablette adres `localhost` olduğu için tarayıcı bunu güvenli bağlam sayar: ekranı açık tutma (Wake Lock) ve tam ekran PWA çalışır.

## Windows ve macOS

Ajan iki sistemde de çalışır; ortak kod `server/`, sisteme özel kısımlar `server/platform/win32.js` ve `server/platform/darwin.js` içindedir. Tablet arayüzü ve USB bağlantısı aynıdır.

| | Windows | macOS (henüz gerçek Mac'te denenmedi) |
|---|---|---|
| CPU, bellek, ağ, disk, süreçler | var | var |
| GPU | NVIDIA (nvidia-smi) | yok — yönetici izni olmadan okunamıyor |
| Pencere listesi | pencere başlıklarıyla | açık uygulamalar (başlıksız) |
| Dokununca öne getirme | var | var |
| Temizlik | geçici, tarayıcı, npm, DNS, Geri Dönüşüm | geçici, tarayıcı, npm, Çöp Kutusu (DNS yok: parola ister) |
| Açılışta başlatma | Başlangıç kısayolu | LaunchAgent |
| Ses düzeyi (SES widget'ı) | Core Audio (varsayılan çıkış) | `osascript` (düzeyi olmayan çıkışlarda, ör. HDMI, boş kalır) |
| Müzik | Windows medya oturumu (Spotify öncelikli) | Spotify ve Müzik uygulaması (AppleScript) |
| Dock simgeleri | programın kendi simgesi | uygulama paketinin `.icns` dosyası |
| APK derleme (`npm run apk`) | var | var (aynı `scripts/build-apk.js`) |

Mac'te kurulum: Node 22.5 veya üstü ve adb gerekir (`brew install node android-platform-tools`), proje klasöründe `npm run kur`. İlk çalıştırmada macOS birkaç kez izin sorar: uygulama listesi ve öne getirme için "System Events", Çöp Kutusu için "Finder", müzik için "Spotify / Müzik" denetimi. İzin verilmezse yalnızca o bölüm boş kalır.

Tableti iki bilgisayarda da kullanmak için proje klasörünü (içindeki `data/` ve `android/devdeck.keystore` ile birlikte) Mac'e kopyalamak yeterlidir; tabletteki uygulama aynıdır, yeniden kurmak gerekmez. Ekran düzeni ve profiller `data/` içinde olduğu için her bilgisayarın kendi kopyası olur.

## Çalıştırma

Bilgisayarda elle hiçbir şey çalıştırılmaz:

- Ajan oturum açılınca gizli başlar (Windows: Başlangıç klasöründeki `DevDeck.lnk`; macOS: `~/Library/LaunchAgents/com.devdeck.agent.plist`). Çıktısı `devdeck.log` dosyasına yazılır.
- Ajan 3 saniyede bir USB'yi yoklar; tablet takılınca portu yönlendirir, ekranı uyandırır ve panel açık değilse açar.

Tek seferlik tablet ayarı: Geliştirici seçenekleri → USB hata ayıklama; ilk takışta çıkan pencerede **Bu bilgisayara her zaman izin ver**; Chrome menüsü → **Ana ekrana ekle**.

Komutlar: `npm run kur` (açılışa ekle), `npm run kaldir` (açılıştan çıkar), `npm start` (geliştirirken elle çalıştır). Yalnızca belirli bir cihaz bağlansın istenirse `DEVDECK_SERIAL` ortam değişkenine seri numarası yazılır.

## Yol haritası

### Faz 1 — Temel (tamamlandı)
- [x] Ajan: CPU (çekirdek bazında), RAM, GPU, ağ, disk, süreçler, açık pencereler
- [x] Claude paneli: son 5 saat / bugün / 7 gün token kullanımı, saatlik grafik, model dağılımı, oturumlar, aktif oturum sayısı
- [x] Dokunma: pencereye dokun → bilgisayarda öne gelir
- [x] Tam ekran düğmesi, PWA manifesti, ekranı açık tutma, bağlantı göstergesi

- [x] Temizlik düğmesi: tara → boyutları göster → onayla → sil (geçici dosyalar, tarayıcı önbelleği, npm önbelleği, DNS, Geri Dönüşüm Kutusu). Hedefler `server/ps/clean.ps1` içinde sabit; tabletten yol gönderilemez.
- [x] Yatay ekrana sığma: yazı boyutu ekran genişliği ve yüksekliğine göre ölçeklenir

- [x] Widget sistemi: 12×8 ızgara, DÜZENLE modunda sürükle-taşı, köşeden boyutlandır, ekle / kaldır, sıfırla
- [x] Widget tasarımları (CPU, bellek, GPU: grafik / gösterge / sayı; Claude: tam / özet) ve 6 renk teması
- [x] Düzen bilgisayarda `data/layout.json` içinde saklanır

- [x] Android uygulaması (`android/`, paket `com.bikorch.deck`): tam ekran, yatay kilitli, ekran hep açık, PC yokken bekleme ekranı ve otomatik yeniden bağlanma. `npm run apk` derler ve takılı tablete kurar (Gradle gerekmez; `ANDROID_HOME` + JDK yeter). Ajan tablet takılınca bu uygulamayı açar.
- [x] Bikorch entegrasyonu: Bikorch'un `workspace.db` dosyası salt okunur okunur (projeler, aktif proje, hesap limitleri); Claude Code oturumları projelere eşlenir (ÇALIŞIYOR / TAMAM / boşta); iş bitince tablette "İŞ TAMAM" bildirimi ve ses. Bikorch kendi bildirimlerini `POST /api/bikorch/notice` ile gönderebilir (`{projectName, title, outcome: "done"|"error", heading}`) — Bikorch tarafındaki çağrı henüz eklenmedi.
- [x] Ad Bikorch Deck, varsayılan tema Bikorch renkleri, simge Bikorch simgesi. İç adlar (`DevDeck.lnk`, `devdeck.log`, `DEVDECK_SERIAL`) aynı kaldı.
- [x] Izgara 24×16 (ince ayar); eski 12×8 düzenler açılışta çevrilir.
- [x] Ayarlar (dişli): bitti sesi, ekran bildirimi, ses türü ve seviyesi, alt şerit, tema, ekranı düzenle. Ayarlar düzenle birlikte `data/layout.json` içinde saklanır.
- [x] Alt şerit (dock): açık pencereler, etkin olan büyük; dokununca öne gelir. En sağında roket: açılabilir alan (ajan 20 dakikada bir ölçer, silmez) ve temizlik ekranı.
- [x] ÇALIŞMA ALANI widget'ı: aynı alanda Bikorch ↔ Claude geçiş anahtarı.
- [x] Gerçek tablette denendi: Galaxy Tab A7 Lite (SM-T220, 1340×800, Android 14)

### Faz 2 — Tableti bağlama ve kiosk
- [ ] Gerçek tablette deneme, çözünürlüğe göre yerleşim ayarı
- [ ] macOS modülünü gerçek Mac'te deneme ve düzeltme
- [x] Ajanı Windows açılışında otomatik başlatma
- [x] Tablet takılınca port yönlendirme + paneli otomatik açma (gerçek cihazla denenecek)
- [ ] Tam kiosk: ekran sabitleme veya Fully Kiosk Browser (durum çubuğu tamamen gizli, şarjdayken ekran hep açık)

### Faz 3 — Claude limitleri
- [ ] **Kalan limit yüzdesi** (5 saatlik ve haftalık) ve sıfırlanma sayacı. Bu bilgi yerel kayıt dosyalarında yok; kaynağı araştırılacak (Claude Code durum satırı verisi ya da uygulamanın kullanım sorgusu).
- [ ] Oturum detayı: dokununca son mesajlar, çalışan araç, token dökümü
- [ ] Oturum bitince / onay bekleyince tablette uyarı

### Faz 4 — Dokunmatik kontrol paneli
- [ ] Sayfalar arası kaydırma (Genel · Claude · Süreçler · Kısayollar)
- [ ] Kısayol düğmeleri: uygulama aç, komut çalıştır, ses/medya kontrolü
- [ ] Süreç sonlandırma (onaylı), pencere küçült/kapat
- [ ] Bir uygulamanın tüm pencereleri (şu an uygulama başına ana pencere listelenir)

### Faz 5 — Geliştirici verileri
- [ ] Git: açık depoların dalı, değişiklik sayısı
- [ ] Dinlenen portlar / çalışan dev sunucuları, Docker konteynerleri
- [ ] CPU sıcaklığı (LibreHardwareMonitor gerekir), eşik uyarıları
- [ ] Yeni widget türleri: kısayol düğmeleri, medya kontrolü, not, hava durumu, takvim
- [ ] Birden çok sayfa (kaydırarak geçiş) ve kayıtlı düzen profilleri

## Dosyalar

| Yol | Görev |
|---|---|
| `server/index.js` | HTTP + SSE sunucusu, CPU/RAM örnekleme, tablet algılama |
| `server/claude.js` | Claude oturum kayıtlarını artımlı okur |
| `server/bikorch.js` | Bikorch veritabanını okur, projeleri ve bildirimleri hazırlar |
| `server/clean.js` | Temizlik: tarama ve silme (ortak) |
| `server/platform/win32.js`, `darwin.js` | Sisteme özel toplayıcı, öne getirme, temizlik hedefleri |
| `server/ps/*.ps1` | Windows: pencere/süreç toplayıcı, öne getirme, DNS ve Geri Dönüşüm |
| `scripts/autostart.js` | Açılışta başlatmayı kurar / kaldırır (iki sistem) |
| `public/` | Tablet arayüzü (HTML/CSS/JS, PWA) |
| `scripts/autostart.ps1`, `devdeck-hidden.vbs` | Windows: açılış kısayolu ve penceresiz başlatma |
