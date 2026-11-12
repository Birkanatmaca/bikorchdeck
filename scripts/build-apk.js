// Bikorch Deck: android/build/bikorch-deck.apk dosyasını Android SDK komut satırı araçlarıyla derler (Gradle yok).
// Windows ve macOS'ta aynı çalışır. Gerekenler: Android SDK (build-tools + bir platform) ve PATH'te bir JDK.
//   node scripts/build-apk.js            -> yalnızca derle
//   node scripts/build-apk.js --install  -> derle, tablete kur ve aç
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const win = process.platform === 'win32';
const root = path.join(__dirname, '..');
const a = path.join(root, 'android');
const out = path.join(a, 'build');
const fail = (msg) => { console.error(msg); process.exit(1); };

// SDK: önce ortam değişkeni, yoksa Android Studio'nun varsayılan klasörü.
const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
  win ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Library', 'Android', 'sdk')]
  .find((d) => d && fs.existsSync(path.join(d, 'build-tools')));
if (!sdk) fail('Android SDK bulunamadı. ANDROID_HOME değişkenini SDK klasörüne ayarla (içinde build-tools olmalı).');

const num = (s) => s.split(/\D+/).filter(Boolean).map(Number);
const newest = (dir) => {
  let list = [];
  try { list = fs.readdirSync(dir).filter((n) => /\d/.test(n)); } catch { /* yok */ }
  list.sort((x, y) => { const p = num(x), r = num(y); for (let i = 0; i < 4; i++) if ((p[i] || 0) !== (r[i] || 0)) return (p[i] || 0) - (r[i] || 0); return 0; });
  return list.length ? path.join(dir, list[list.length - 1]) : null;
};
const bt = newest(path.join(sdk, 'build-tools'));
const pf = newest(path.join(sdk, 'platforms'));
if (!bt || !pf) fail('SDK içinde build-tools ya da platforms eksik (Android Studio > SDK Manager ile kur).');
const jar = path.join(pf, 'android.jar');
const tool = (name, ext) => path.join(bt, name + (win ? ext : ''));

// Windows'ta .bat dosyaları ve PATH'teki araçlar kabuk üzerinden çalışır; bu yüzden argümanlar tırnaklanır.
function step(name, cmd, args, { optional } = {}) {
  console.log('> ' + name);
  const r = win
    ? spawnSync([cmd, ...args].map((s) => `"${s}"`).join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') fail(`${cmd} bulunamadı (JDK ve Android araçları PATH'te olmalı).`);
  if (r.status !== 0 && !optional) fail(`${name} başarısız (kod ${r.status})`);
}
const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'classes'), { recursive: true });

step('kaynakları derle', tool('aapt2', '.exe'), ['compile', '--dir', path.join(a, 'res'), '-o', path.join(out, 'res.zip')]);
step('paketi bağla', tool('aapt2', '.exe'), ['link', '-o', path.join(out, 'base.apk'), '-I', jar, '--manifest', path.join(a, 'AndroidManifest.xml'), path.join(out, 'res.zip')]);
step('java derle', 'javac', ['-nowarn', '-source', '11', '-target', '11', '-classpath', jar, '-d', path.join(out, 'classes'), ...walk(path.join(a, 'src'), '.java')]);
step('dex oluştur', tool('d8', '.bat'), ['--release', '--min-api', '26', '--lib', jar, '--output', out, ...walk(path.join(out, 'classes'), '.class')]);
step('dex ekle', 'jar', ['uf', path.join(out, 'base.apk'), '-C', out, 'classes.dex']);
step('hizala', tool('zipalign', '.exe'), ['-f', '4', path.join(out, 'base.apk'), path.join(out, 'aligned.apk')]);

// Kendinden imzalı anahtar proje içinde durur; sonraki derlemeler kurulu uygulamayı güncelleyebilsin diye.
// Parola yalnızca bu yerel kurulum anahtarını korur, gizli değildir. Başka bilgisayarda derlerken aynı
// android/devdeck.keystore dosyasını kullan; yoksa tablet "imza uyuşmuyor" der ve önce eskisini kaldırmak gerekir.
const ks = path.join(a, 'devdeck.keystore');
if (!fs.existsSync(ks)) {
  step('imza anahtarı oluştur', 'keytool', ['-genkeypair', '-keystore', ks, '-alias', 'devdeck', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '20000', '-storepass', 'devdeck', '-keypass', 'devdeck', '-dname', 'CN=DevDeck']);
}
const apk = path.join(out, 'bikorch-deck.apk');
step('imzala', tool('apksigner', '.bat'), ['sign', '--ks', ks, '--ks-pass', 'pass:devdeck', '--out', apk, path.join(out, 'aligned.apk')]);
console.log(`APK hazır: ${apk} (${Math.round(fs.statSync(apk).size / 1024)} KB)`);

if (process.argv.includes('--install')) {
  const adb = process.env.ADB || 'adb';
  step('eski adlı uygulamayı kaldır (varsa)', adb, ['uninstall', 'com.devdeck.tablet'], { optional: true });
  step('tablete kur', adb, ['install', '-r', apk]);
  step('uygulamayı aç', adb, ['shell', 'am', 'start', '-n', 'com.bikorch.deck/.MainActivity']);
}
