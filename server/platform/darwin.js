// macOS'a özel kısımlar. Sistem araçlarıyla çalışır (ps, netstat, vm_stat, osascript); ek kurulum gerekmez.
// Açık uygulama listesi ve öne getirme "System Events" kullanır: ilk çalıştırmada macOS bir kez izin sorar.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { profiles } = require('../util');

const sh = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { timeout: 8000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out))));
const osa = (script) => sh('osascript', ['-e', script]);

const APPS = 'tell application "System Events" to get {name, unix id, frontmost} of (every process whose background only is false)';
const cores = os.cpus().length;
let prevNet = null, prevT = 0;

function parseProcs(out) {
  const agg = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.,]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const name = path.basename(m[4].trim());
    const a = agg.get(name) || { name, cpu: 0, mem: 0, n: 0 };
    a.cpu += parseFloat(m[2].replace(',', '.')) || 0; // tek çekirdeğin yüzdesi
    a.mem += +m[3]; // KB
    a.n++;
    agg.set(name, a);
  }
  const all = [...agg.values()].map((a) => ({ name: a.name, n: a.n, cpu: Math.round((a.cpu / cores) * 10) / 10, mem: Math.round(a.mem / 1024) }));
  return {
    procs: all.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 10),
    memTop: all.slice().sort((a, b) => b.mem - a.mem).slice(0, 5).map(({ name, n, mem }) => ({ name, n, mem })),
  };
}

// osascript üç listeyi düz yazar: "Finder, Safari, 312, 480, false, true"
function parseApps(out) {
  const t = out.trim().split(', ');
  const n = t.length / 3;
  if (!out.trim() || !Number.isInteger(n)) return null;
  return Array.from({ length: n }, (_, i) => ({
    name: t[i], title: t[i], pid: +t[n + i], hwnd: +t[n + i], active: t[2 * n + i] === 'true',
  })).filter((w) => Number.isSafeInteger(w.hwnd));
}

function parseNet(out) {
  let rx = 0, tx = 0;
  for (const line of out.split('\n')) {
    if (!line.includes('<Link#') || line.startsWith('lo')) continue;
    const c = line.trim().split(/\s+/);
    rx += +c[c.length - 5] || 0; // Ibytes
    tx += +c[c.length - 2] || 0; // Obytes
  }
  return { rx, tx };
}

// os.freemem() macOS'ta yalnızca tamamen boş sayfaları sayar; kullanılabilir belleği vm_stat'tan hesapla.
function parseMem(out) {
  const page = +(out.match(/page size of (\d+)/) || [])[1];
  if (!page) return null;
  const get = (k) => +(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`)) || [])[1] || 0;
  return os.totalmem() - (get('free') + get('inactive') + get('speculative') + get('purgeable')) * page;
}

async function sample(state) {
  const [psOut, apps, net, vm] = await Promise.all([
    sh('ps', ['-axo', 'pid=,pcpu=,rss=,comm=']), osa(APPS), sh('netstat', ['-ib']), sh('vm_stat', []),
  ]);
  if (psOut) Object.assign(state, parseProcs(psOut));
  const wins = parseApps(apps);
  if (wins) state.windows = wins;
  const used = parseMem(vm);
  if (used) module.exports.memUsed = used;
  if (net) {
    const cur = parseNet(net), now = Date.now();
    if (prevNet) {
      const dt = (now - prevT) / 1000 || 1;
      state.net = { rx: Math.max(0, Math.round((cur.rx - prevNet.rx) / dt)), tx: Math.max(0, Math.round((cur.tx - prevNet.tx) / dt)) };
    }
    prevNet = cur; prevT = now;
  }
  try {
    const s = fs.statfsSync('/');
    state.disks = [{ name: '/', total: s.blocks * s.bsize, free: s.bavail * s.bsize }];
  } catch { /* eski Node */ }
}

// --- Ses düzeyi: "output volume:50, input volume:58, alert volume:100, output muted:false" ---
function parseAudio(out) {
  const v = /output volume:(\d+)/.exec(out), m = /output muted:(true|false)/.exec(out);
  return v ? { vol: +v[1], mute: !!m && m[1] === 'true' } : null; // bazı çıkışlarda (HDMI vb.) düzey yoktur
}
function volume(o, cb) {
  const args = [];
  if ('vol' in o) args.push('-e', `set volume output volume ${Number(o.vol)}`);
  if ('mute' in o) args.push('-e', `set volume output muted ${o.mute ? 'true' : 'false'}`);
  execFile('osascript', args, { timeout: 8000 }, (err) => cb(err));
}

// --- Çalan müzik: Spotify ya da Müzik (Music) uygulaması AppleScript ile sorulur. ---
// Yalnızca o an çalışan uygulamaya sorulur: kurulu olmayan bir uygulamayı anan betik macOS'ta pencere açtırır.
// İlk kullanımda macOS bir kez "Spotify'ı / Müzik'i denetleme" izni sorar.
const MEDIA = path.join(__dirname, '..', '..', 'data', 'media');
const mediaArt = path.join(MEDIA, 'art.img');
const PLAYERS = ['Spotify', 'Music'];
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const nowScript = (app) => ['-e', `tell application "${app}"`, '-e', 'try',
  '-e', 'if player state is stopped then return ""', '-e', 'set t to current track',
  '-e', `return (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & (player state as text) & linefeed${app === 'Spotify' ? ' & (artwork url of t)' : ''}`,
  '-e', 'on error', '-e', 'return ""', '-e', 'end try', '-e', 'end tell'];
function parseNow(app, out) {
  const p = out.replace(/\n$/, '').split('\n');
  if (p.length < 4 || !p[0]) return null;
  return { app, title: p[0], artist: p[1], album: p[2], playing: p[3] === 'playing', artUrl: p[4] || '' };
}
let player = null, artKey = '', artSeq = 0, artBusy = false;
function saveArt(m, key) {
  const done = (ok) => { artBusy = false; if (ok) { artKey = key; artSeq++; } };
  artBusy = true;
  if (m.app === 'Spotify') { // kapak adresi Spotify'ın kendi sunucusundadır
    if (!/^https:\/\//.test(m.artUrl)) { done(false); return; }
    const req = require('https').get(m.artUrl, { timeout: 8000 }, (res) => {
      const chunks = []; let n = 0;
      if (res.statusCode !== 200) { res.resume(); done(false); return; }
      res.on('data', (d) => { n += d.length; if (n > 5 << 20) req.destroy(); else chunks.push(d); });
      res.on('end', () => fs.writeFile(mediaArt, Buffer.concat(chunks), (e) => done(!e && n > 100)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
    return;
  }
  sh('osascript', ['-e', 'tell application "Music" to set d to raw data of artwork 1 of current track',
    '-e', `set f to open for access (POSIX file ${q(mediaArt)}) with write permission`,
    '-e', 'set eof f to 0', '-e', 'write d to f', '-e', 'close access f', '-e', 'return "ok"'])
    .then((r) => done(r.trim() === 'ok'));
}
async function sampleMedia(state) {
  const running = PLAYERS.filter((a) => state.windows.some((w) => w.name === a));
  let m = null;
  for (const app of running) {
    m = parseNow(app, await sh('osascript', nowScript(app)));
    if (m) break;
  }
  player = m ? m.app : running[0] || null;
  if (!m) { state.media = null; return; }
  const key = `${m.app}|${m.title}|${m.artist}`;
  if (key !== artKey && !artBusy) { fs.mkdirSync(MEDIA, { recursive: true }); saveArt(m, key); }
  state.media = { app: m.app, title: m.title, artist: m.artist, album: m.album, playing: m.playing, art: key === artKey ? artSeq : 0 };
}
function media(cmd, cb) {
  const verb = { next: 'next track', prev: 'previous track', toggle: 'playpause' }[cmd];
  if (!player || !verb) { cb(new Error('çalan uygulama yok')); return; }
  execFile('osascript', ['-e', `tell application "${player}" to ${verb}`], { timeout: 8000 }, (err) => cb(err));
}

// --- Uygulama simgesi: paketin .icns dosyası PNG'ye çevrilir (dock için) ---
function icon(pid, file, cb) {
  execFile('ps', ['-o', 'comm=', '-p', String(Number(pid))], { timeout: 5000 }, (err, out) => {
    const m = /^(.*?\.app)\//.exec(String(out || '').trim());
    if (err || !m) { cb(err || new Error('uygulama paketi yok')); return; }
    execFile('defaults', ['read', `${m[1]}/Contents/Info`, 'CFBundleIconFile'], { timeout: 5000 }, (e, name) => {
      let n = String(name || '').trim();
      if (e || !n) { cb(e || new Error('simge yok')); return; }
      if (!/\.icns$/i.test(n)) n += '.icns';
      execFile('sips', ['-s', 'format', 'png', '-Z', '128', `${m[1]}/Contents/Resources/${n}`, '--out', file], { timeout: 15000 }, (e2) => cb(e2));
    });
  });
}

function startCollector(state) {
  const extra = async () => {
    state.audio = parseAudio(await osa('get volume settings'));
    await sampleMedia(state);
  };
  const loop = () => Promise.all([sample(state), extra()]).catch((e) => console.error('[collector]', e.message)).finally(() => setTimeout(loop, 2000));
  loop();
}

// Apple Silicon GPU kullanımı yönetici izni olmadan okunamıyor; panel boş kalır.
function sampleGpu() {}

function focus(pid, cb) {
  execFile('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(pid)}) to true`],
    { timeout: 8000 }, (err) => cb(err));
}

function cleanDefs() {
  const caches = path.join(os.homedir(), 'Library', 'Caches');
  const browsers = ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser'].map((b) => path.join(caches, b));
  return {
    temp: { paths: [os.tmpdir()], days: 1 },
    browser: { paths: browsers.flatMap((b) => profiles(b, ['Cache', 'Code Cache'])), days: 0 },
    npm: { paths: [path.join(os.homedir(), '.npm', '_cacache')], days: 0 },
  };
}

// Çöp Kutusu Finder üzerinden (boyut bilgisi alınamaz, yalnızca öğe sayısı).
// DNS temizliği macOS'ta yönetici parolası istediği için burada yok.
const special = {
  recycle: async (mode, cb) => {
    const r = { id: 'recycle', bytes: 0, count: 0, freed: 0, removed: 0 };
    r.count = parseInt(await osa('tell application "Finder" to count items of trash'), 10) || 0;
    if (mode === 'clean' && r.count) {
      await osa('tell application "Finder" to empty trash');
      r.removed = r.count - (parseInt(await osa('tell application "Finder" to count items of trash'), 10) || 0);
    }
    cb(null, r);
  },
};

module.exports = { startCollector, sampleGpu, focus, cleanDefs, special, icon, media, mediaArt, volume, memUsed: null,
  _test: { parseProcs, parseApps, parseNet, parseMem, parseAudio, parseNow, nowScript } };
