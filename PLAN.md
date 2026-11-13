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
- **Bağlantı adb üzerinden (USB kablo ya da kablosuz hata ayıklama).** Ajan sadece `127.0.0.1` dinler; `adb reverse` tabletin `localhost:8787` adresini adb kanalı üzerinden PC'ye bağlar. Ağa hiçbir port açılmaz.
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

### Wi-Fi ile bağlanma (kablosuz)

Kablo yerine Wi-Fi da kullanılabilir (Android 11+). Tablet ve bilgisayar aynı ağda olmalı. Tek seferlik eşleştirme:

1. Tablette Geliştirici seçenekleri → **Kablosuz hata ayıklama**'yı aç → **Eşleştirme kodu ile cihaz eşleştir**.
2. Bilgisayarda: `adb pair <ekrandaki IP:port>` ve ekrandaki 6 haneli kod.

Sonrasında ajan ağı 10 saniyede bir tarar, eşleşmiş tableti bulunca kendisi bağlanır ve USB'deki gibi portu yönlendirip paneli açar. Ajan yine yalnızca `127.0.0.1` dinler; trafik adb'nin şifreli kanalından geçer, ağdaki başka cihazlar panele ulaşamaz. Tablet yeniden başlarsa veya ağ değişirse tablette Kablosuz hata ayıklamayı yeniden açmak gerekebilir.

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
- [x] macOS'ta gerçek Mac'te denendi. Bikorch terminallerinin Claude kayıtları (`Bikorch/cli-profiles/claude/<hesap>/projects`) da okunur; Bikorch'un çalışma klasörleri (`agent-worktrees/<repo_hash>/…`) `agent_isolation_state` tablosuyla asıl projeye eşlenir. Bikorch'un iç oturumları (ana sayfa sohbeti vb.) proje sayılmaz.
- [x] Wi-Fi bağlantısı (kablosuz adb) ve üst çubukta USB / Wi-Fi göstergesi (ayrı simge ve renk).
- [x] macOS Çöp Kutusu boyutu Finder'dan okunur ve açılabilir alana eklenir.
- [x] ChatGPT Codex (`server/codex.js`): `~/.codex/sessions` ve Bikorch'un Codex profilleri okunur (masaüstü, VS Code, CLI). Çalışan / biten işler projelere eşlenir, biten iş "İŞ TAMAM" bildirimi olur; Codex limitleri (5 saat / haftalık), bugünkü token, son yanıt ve oturumlar. ÇALIŞMA ALANI'nda BIKORCH · CLAUDE · CODEX sekmeleri (iş süren sekmede nokta yanar); Bikorch listesinde işi yapan ajan etiketi. Ayrı CODEX widget'ı da eklenebilir.
- [x] Komik bitti sesleri: Ayarlar → Ses türü bir seçim ekranı açar (dokun: seç ve dinle). Gerçek sesler (gol, tribün, çığlık, eşek, palyaço...) Mixkit ve Wikimedia Commons'tan, konuşanlar macOS Yelda sesiyle; `node scripts/make-sounds.js` indirir, kırpar, karıştırır ve `public/sounds/*.m4a` üretir (kaynaklar `public/sounds/KAYNAKLAR.md`; dosyalar depoda, Windows'ta da çalar). "PROJE ADIYLA" biten işin proje adını ajan o an seslendirir (`/voice`, macOS `say` / Windows System.Speech; metni istemci gönderemez), "RASTGELE" her seferinde başka ses. Kendi seslerin: `data/sounds/` içine atılan mp3/m4a/wav/ogg seçme ekranında görünür. Hata bitişinde komik seslerde hüzünlü trombon çalar.
- [x] Nöbet modu (`public/guard.js`, `server/guard.js`): tabletin ön kamerası masaya bakar, yüz tanıma tablette yapılır (face-api.js + TensorFlow.js WASM, `public/vendor/face-api`; Mali gibi tablet GPU'ları WebGL'de yarım hassasiyetle yüz bulamadığı için WASM). Başlıktaki NÖBET düğmesi → yüzünü tanıt (12 örnek: düz, sağa, sola, yukarı) ve 4–8 haneli şifre. Sahibi görünüyorsa sessiz; tanımadığı yüz 2 kare üst üste görünürse fotoğraf + "Seni tanıyamadım, şifreni gir" + geri sayım (3/6/10/15 sn), süre dolunca kırmızı alarm, siren, ikinci fotoğraf ve bilgisayar kilitlenir (macOS `pmset displaysleepnow`, Windows LockWorkStation). Doğru şifre ya da sahibinin yüzü alarmı kapatır; şifreden sonra nöbet 2 dk–2 sa susturulur ve "BU BENDİM, YÜZÜMÜ ÖĞREN" ile o anki yüz kayda eklenir. Fotoğraflar `data/guard/intruders` içinde, ayarlar ekranında "MASANA GELENLER" (dokun: büyük görüntüle, ‹ › ile gez, tek tek ya da hepsini sil). Şifre PBKDF2 özeti olarak saklanır, 5 yanlışta 60 sn bekletir. APK'da kamera izni gerekir (sürüm 1.2).
- [x] Temizlik (macOS): geçici dosyalar, tarayıcı (Chrome / Edge / Brave + headless Chrome), geliştirici önbellekleri (Xcode DerivedData, go-build, pnpm, yarn, React Native, node-gyp, CocoaPods, Homebrew, uv…), uygulama önbellekleri (Electron uygulamalarının Cache / Code Cache / GPUCache klasörleri, Spotify), npm, bir haftadan eski günlükler ve Çöp. Boyut diskte gerçekten kaplanan alandır (blok sayısı; hard link'li dosyalar sayılmaz). Ekranda disk çubuğu ("temizlikten sonra X boş"), her tür için oran çubuğu; alttaki roketin altında türlere göre renkli çubuk.
