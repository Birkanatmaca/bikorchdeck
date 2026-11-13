// Windows'a özel kısımlar: PowerShell toplayıcı, nvidia-smi, pencere öne getirme, temizlik hedefleri.
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { profiles } = require('../util');

const PS = path.join(__dirname, '..', 'ps');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const ps = (file, args, opts, cb) => execFile('powershell.exe', [...PS_ARGS, path.join(PS, file), ...args], { windowsHide: true, ...opts }, cb);

// Pencereler / süreçler / ağ / disk: 2 sn'de bir JSON satırı basan kalıcı PowerShell süreci.
function startCollector(state) {
  const child = spawn('powershell.exe', [...PS_ARGS, path.join(PS, 'collector.ps1'), '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        state.windows = o.windows || [];
        state.procs = o.procs || [];
        state.memTop = o.memTop || [];
        state.net = o.net || state.net;
        state.disks = o.disks || [];
      } catch { /* yarım satır */ }
    }
  });
  child.stderr.on('data', (d) => console.error('[collector]', String(d).trim()));
  child.on('exit', (code) => {
    console.error(`[collector] çıktı (${code}), 3 sn sonra yeniden başlatılıyor`);
    setTimeout(() => startCollector(state), 3000);
  });
  process.on('exit', () => child.kill());
}

let gpuOk = true;
function sampleGpu(state) {
  if (!gpuOk) return;
  execFile('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ], { windowsHide: true, timeout: 4000 }, (err, out) => {
    if (err) { if (err.code === 'ENOENT') gpuOk = false; return; }
    const v = out.trim().split('\n')[0].split(',').map((s) => s.trim());
    if (v.length < 6) return;
    state.gpu = { name: v[0], util: +v[1] || 0, memUsed: +v[2] || 0, memTotal: +v[3] || 0, temp: +v[4] || 0, power: +v[5] || 0 };
  });
}

// Çalan müzik (Spotify öncelikli) ve ses düzeyi: kalıcı PowerShell süreci 2 sn'de bir durum satırı basar,
// kapağı dosyaya yazar. Komutlar (next / prev / toggle, ses düzeyi) küçük dosyalar üzerinden iletilir.
const MEDIA = path.join(__dirname, '..', '..', 'data', 'media');
const mediaArt = path.join(MEDIA, 'art.img');
function startMedia(state) {
  require('fs').mkdirSync(MEDIA, { recursive: true });
  const child = spawn('powershell.exe', [...PS_ARGS, path.join(PS, 'media.ps1'), '-Art', mediaArt, '-Cmd', path.join(MEDIA, 'cmd'), '-VolCmd', path.join(MEDIA, 'vol'), '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try {
        const o = JSON.parse(line);
        state.media = o.media || null;
        state.audio = typeof o.vol === 'number' ? { vol: o.vol, mute: !!o.mute } : null;
      } catch { /* yarım satır */ }
    }
  });
  child.stderr.on('data', (d) => console.error('[media]', String(d).trim().slice(0, 200)));
  child.on('exit', () => { state.media = null; state.audio = null; setTimeout(() => startMedia(state), 10000); });
  process.on('exit', () => child.kill());
}
function media(cmd, cb) { require('fs').writeFile(path.join(MEDIA, 'cmd'), cmd, cb); }
// o: { vol: 0..100 } ve/veya { mute: true|false } (değerler index.js'te doğrulanır)
function volume(o, cb) {
  const lines = [];
  if ('vol' in o) lines.push('v ' + o.vol);
  if ('mute' in o) lines.push('m ' + (o.mute ? 1 : 0));
  require('fs').writeFile(path.join(MEDIA, 'vol'), lines.join('\n'), cb);
}

// Çalışan programın simgesini PNG olarak kaydeder (dock için).
function icon(pid, file, cb) {
  ps('icon.ps1', ['-ProcId', String(pid), '-Out', file], { timeout: 15000 }, (err) => cb(err));
}

// "PROJE ADIYLA" bildirim sesi: Windows'un konuşma motoru (System.Speech) WAV dosyasına yazar.
// Türkçe ses kuruluysa o seçilir. Metin ve yol komut satırına değil ortam değişkenine konur (kaçış sorunu olmasın).
function speak(text, file, cb) {
  const script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
    + "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'tr-TR' } | Select-Object -First 1; "
    + "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.Rate = 1; $s.SetOutputToWaveFile($env:DECK_OUT); $s.Speak($env:DECK_TEXT); $s.Dispose()";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, env: { ...process.env, DECK_TEXT: text, DECK_OUT: file } }, (err) => cb(err, 'audio/wav'));
}

function focus(hwnd, cb) {
  ps('focus.ps1', ['-Hwnd', String(hwnd)], { timeout: 8000 }, (err) => cb(err));
}

// Dosya tabanlı temizlik hedefleri (silme işini ortak clean.js yapar).
function cleanDefs() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const browsers = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'].map((b) => path.join(la, b, 'User Data'));
  return {
    temp: { paths: [os.tmpdir()], days: 1 },
    browser: { paths: browsers.flatMap((b) => profiles(b, ['Cache\\Cache_Data', 'Code Cache'])), days: 0 },
    npm: { paths: [path.join(la, 'npm-cache', '_cacache')], days: 0 },
  };
}

// Dosya olmayan hedefler: clean.ps1 üzerinden.
const viaPs = (id) => (mode, cb) => ps('clean.ps1', ['-Mode', mode, '-Targets', id], { timeout: 120000 }, (err, out) => {
  try { cb(null, JSON.parse(String(out).trim())[0]); } catch (e) { cb(err || e); }
});
const special = { dns: viaPs('dns'), recycle: viaPs('recycle') };

// Nöbet alarmı: Windows oturumunu kilitler (Win+L ile aynı).
const lock = (cb) => execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, timeout: 5000 }, (e) => cb && cb(e));

module.exports = {
  lock, icon, startMedia, media, mediaArt, volume, speak, startCollector, sampleGpu, focus, cleanDefs, special };
