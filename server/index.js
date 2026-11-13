// Bikorch Deck ajanı: PC'den (Windows veya macOS) metrikleri toplar, tablete SSE ile yayınlar.
// Yalnızca 127.0.0.1'i dinler; tablet USB üzerinden `adb reverse` ile bağlanır.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const claude = require('./claude');
const codex = require('./codex');
const clean = require('./clean');
const bikorch = require('./bikorch');
const guard = require('./guard');

let plat;
try { plat = require(`./platform/${process.platform}`); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.error(`Bu işletim sistemi desteklenmiyor: ${process.platform} (yalnızca Windows ve macOS)`);
  process.exit(1);
}

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUB = path.join(__dirname, '..', 'public');
const HIST = 120;
const CLEAN_IDS = clean.ids(plat);

const state = {
  host: os.hostname(), os: process.platform, cores: os.cpus().length, cpuModel: os.cpus()[0].model.trim(),
  t: Date.now(), uptime: 0, cleanIds: CLEAN_IDS,
  cpu: { total: 0, cores: [] }, mem: { total: os.totalmem(), used: 0 },
  gpu: null, net: { rx: 0, tx: 0 }, disks: [], windows: [], procs: [], memTop: [], claude: null, codex: null, bikorch: null, notices: [], reclaim: null, limits: null, media: null, audio: null, link: '',
  netx: { iface: '', ip: '', ping: null, online: null, totRx: 0, totTx: 0 },
};
const hist = { cpu: [], mem: [], gpu: [], rx: [], tx: [] };
const push = (k, v) => { hist[k].push(v); if (hist[k].length > HIST) hist[k].shift(); };

// --- CPU / RAM (Node yerleşik) ---
let prevCpu = os.cpus();
function sampleCpu() {
  const cur = os.cpus();
  let idleSum = 0, totSum = 0;
  state.cpu.cores = cur.map((c, i) => {
    const p = prevCpu[i].times, n = c.times;
    const idle = n.idle - p.idle;
    const tot = Object.keys(n).reduce((s, k) => s + n[k] - p[k], 0);
    idleSum += idle; totSum += tot;
    return tot > 0 ? Math.round((1 - idle / tot) * 100) : 0;
  });
  state.cpu.total = totSum > 0 ? Math.round((1 - idleSum / totSum) * 1000) / 10 : 0;
  prevCpu = cur;
  state.mem.used = plat.memUsed || os.totalmem() - os.freemem();
  state.uptime = os.uptime();
  state.t = Date.now();
}

// --- Ekran düzeni (widget'lar + tema): data/layout.json içinde saklanır ---
const LAYOUT = path.join(__dirname, '..', 'data', 'layout.json');
const word = (s) => typeof s === 'string' && /^[a-z]{1,20}$/.test(s);
function loadLayout() {
  try { return cleanLayout(JSON.parse(fs.readFileSync(LAYOUT, 'utf8'))); } catch { return null; }
}
// Yalnızca bilinen alanları ve makul değerleri kabul eder.
// g: ızgara sürümü (24 = 24x16); sound/toast/vol/tone: bildirim ayarları.
function cleanLayout(o) {
  if (!o || !word(o.theme) || !Array.isArray(o.widgets) || o.widgets.length > 40) return null;
  const widgets = [];
  for (const w of o.widgets) {
    if (!w || !word(w.type) || typeof w.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(w.id)) return null;
    if (!['x', 'y', 'w', 'h'].every((k) => Number.isInteger(w[k]) && w[k] >= 0 && w[k] <= 24)) return null;
    if (w.variant !== undefined && !word(w.variant)) return null;
    widgets.push({ id: w.id, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, variant: w.variant });
  }
  const out = { theme: o.theme, widgets };
  if (o.g === 24) out.g = 24;
  if (typeof o.sound === 'boolean') out.sound = o.sound;
  if (typeof o.toast === 'boolean') out.toast = o.toast;
  if (typeof o.dock === 'boolean') out.dock = o.dock;
  if (Number.isInteger(o.vol) && o.vol >= 0 && o.vol <= 10) out.vol = o.vol;
  if (typeof o.tone === 'string' && /^[a-z0-9-]{1,40}$/.test(o.tone)) out.tone = o.tone; // kendi seslerin: my-<ad>
  return out;
}

// --- Ekran profilleri: adlandırılmış düzen kayıtları, data/profiles.json içinde kalıcıdır ---
const PROFILES = path.join(__dirname, '..', 'data', 'profiles.json');
const pname = (s) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 24) : '') || 'Profil';
function saveProfiles(p) {
  fs.mkdirSync(path.dirname(PROFILES), { recursive: true });
  fs.writeFileSync(PROFILES, JSON.stringify(p, null, 1));
}
function loadProfiles() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(PROFILES, 'utf8')); } catch { /* henüz yok */ }
  const list = [];
  for (const e of (p && Array.isArray(p.list) ? p.list : []).slice(0, 12)) {
    const l = e && cleanLayout(e.layout);
    if (l && typeof e.id === 'string' && /^p[a-z0-9]{1,12}$/.test(e.id)) list.push({ id: e.id, name: pname(e.name), layout: l });
  }
  if (!list.length) { // ilk kullanım: şu anki düzen "Profil 1" olur
    const l = loadLayout();
    if (l) { list.push({ id: 'p1', name: 'Profil 1', layout: l }); saveProfiles({ active: 'p1', list }); }
  }
  return { active: p && list.some((e) => e.id === p.active) ? p.active : list[0] ? list[0].id : null, list };
}
const profInfo = (p) => ({ active: p.active, profiles: p.list.map(({ id, name }) => ({ id, name })) });
// op: save (id varsa üzerine yazar, yoksa yeni profil), load, delete
function profileOp(o) {
  if (!o) return null;
  const p = loadProfiles();
  const cur = p.list.find((e) => e.id === o.id);
  if (o.op === 'save') {
    const layout = cleanLayout(o.layout);
    if (!layout) return null;
    if (cur) cur.layout = layout;
    else {
      if (p.list.length >= 12) return null;
      let n = 1;
      while (p.list.some((e) => e.name === 'Profil ' + n)) n++;
      p.list.push({ id: 'p' + Date.now().toString(36), name: 'Profil ' + n, layout });
    }
    p.active = cur ? cur.id : p.list[p.list.length - 1].id;
    saveProfiles(p);
    return profInfo(p);
  }
  if (!cur) return null;
  if (o.op === 'load') { p.active = cur.id; saveProfiles(p); return { ...profInfo(p), layout: cur.layout }; }
  if (o.op === 'delete') {
    p.list = p.list.filter((e) => e !== cur);
    if (p.active === cur.id) p.active = p.list[0] ? p.list[0].id : null;
    saveProfiles(p);
    return profInfo(p);
  }
  return null;
}

// --- Açılabilir alan: temizlik hedefleri arka planda ölçülür (hiçbir şey silinmez) ---
function measure() {
  clean.run(plat, 'scan', CLEAN_IDS).then((items) => {
    const top = items.reduce((a, b) => (b.bytes > a.bytes ? b : a), { id: '', bytes: 0 });
    state.reclaim = { bytes: items.reduce((s, i) => s + (i.bytes || 0), 0), top: top.id, topBytes: top.bytes, at: Date.now(),
      items: items.filter((i) => i.bytes > 0).map(({ id, bytes }) => ({ id, bytes })) };
  }, () => {});
}

// --- Claude kullanımı ---
// --- Bildirimler ("iş tamam"): Claude oturumlarından ve Bikorch'tan gelir, tablette gösterilir ---
let noticeSeq = Date.now();
function notice(n) {
  state.notices.unshift({ id: ++noticeSeq, t: Date.now(), ...n });
  state.notices.length = Math.min(state.notices.length, 12);
  console.log('[bildirim]', n.outcome, n.project, n.src);
}

// --- Claude kullanımı + Bikorch projeleri ---
// Claude Code ve ChatGPT Codex oturumları aynı mantıkla işlenir: proje adına çevrilir, biten işler bildirim olur.
function agentSnap(name, mod) {
  try {
    const c = mod.snapshot();
    c.usage.sessions = c.usage.sessions.map(({ cwd, ...s }) => ({ ...s, project: bikorch.projectName(cwd, s.project) }));
    // Bitti bildirimi Bikorch'taki proje adıyla gösterilir (çalışma klasörünün adıyla değil).
    c.events.filter((e) => !bikorch.internal(e.cwd)).forEach(({ cwd, ...n }) => notice({ ...n, project: bikorch.projectName(cwd, n.project) }));
    return c;
  } catch (e) { console.error(`[${name}]`, e.message); return null; }
}
function sampleClaude() {
  const c = agentSnap('claude', claude), x = agentSnap('codex', codex);
  if (c) state.claude = c.usage;
  if (x) state.codex = x.usage;
  try {
    const work = [...(c ? c.work.map((w) => ({ ...w, src: 'claude' })) : []), ...(x ? x.work : [])];
    state.bikorch = bikorch.snapshot(work, state.windows.some((w) => /^bikorch$/i.test(w.name)));
  } catch (e) { console.error('[bikorch]', e.message); }
}

// --- Tablet (USB): takılınca portu yönlendir, ekranı uyandır, paneli aç ---
const ADB = process.env.ADB || 'adb';
const APP = 'com.bikorch.deck'; // android/ klasöründeki uygulama
const ONLY = process.env.DEVDECK_SERIAL || ''; // doluysa yalnızca bu cihaz
const tablets = new Set();
// Tablet nasıl bağlı: kablosuz adb seri numarası "<ad>._adb-tls-connect._tcp" ya da "IP:port" olur.
const isWifi = (s) => /_adb-tls-connect|^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s);
const setLinkKind = () => { const t = [...tablets]; state.link = !t.length ? '' : t.every(isWifi) ? 'wifi' : 'usb'; };
let androidClients = 0;
const adb = (args, cb) => execFile(ADB, args, { windowsHide: true, timeout: 15000 }, (e, o) => cb && cb(e, String(o || '')));
function attach(serial) {
  tablets.add(serial);
  adb(['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], (err) => {
    if (err) { tablets.delete(serial); return; } // bir sonraki turda yeniden denenir
    console.log('[tablet] bağlandı', serial);
    setLinkKind();
    adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    // Panel tablette zaten açıksa kendiliğinden yeniden bağlanır; yalnızca açık değilse aç.
    setTimeout(() => {
      if (androidClients !== 0 || !tablets.has(serial)) return;
      // Sırayla: Bikorch Deck uygulaması kuruluysa onu, yoksa Chrome'u, o da yoksa varsayılan tarayıcıyı aç.
      const has = (pkg, cb) => adb(['-s', serial, 'shell', 'pm', 'path', pkg], (e, out) => cb(!e && out.includes('package:')));
      const view = ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${PORT}`];
      has(APP, (app) => {
        if (app) { adb(['-s', serial, 'shell', 'am', 'start', '-n', `${APP}/.MainActivity`]); return; }
        has('com.android.chrome', (chrome) => adb(chrome ? [...view, 'com.android.chrome'] : view));
      });
    }, 7000);
  });
}
function watchTablet() {
  adb(['devices'], (err, out) => {
    if (err && err.code === 'ENOENT') { console.error('[tablet] adb bulunamadı; otomatik bağlanma kapalı'); return; }
    if (!err) {
      const now = new Set(out.split('\n').map((l) => l.trim().split('\t')).filter((p) => p[1] === 'device').map((p) => p[0])
        .filter((s) => !ONLY || s === ONLY));
      for (const s of now) if (!tablets.has(s)) attach(s);
      for (const s of tablets) if (!now.has(s)) { tablets.delete(s); console.log('[tablet] ayrıldı', s); setLinkKind(); }
    }
    setTimeout(watchTablet, 3000);
  });
}

// --- Tablet (Wi-Fi): tablette "Kablosuz hata ayıklama" açıksa ağda duyurulur; bu Mac/PC ile bir kez
// eşleştirilmişse (adb pair) ajan ona kendisi bağlanır. Sonrası USB ile aynıdır: watchTablet onu
// "device" olarak görür ve adb reverse yapar. Trafik adb'nin şifreli kanalından geçer; ajan yine yalnızca 127.0.0.1 dinler.
// adb eşleşmiş cihaza çoğu zaman kendisi bağlanır (seri no "<ad>._adb-tls-connect._tcp" olur); bu döngü yalnızca
// cihaz bir süre görünüp de bağlanmadıysa yedek olarak IP:port ile bağlanır, böylece aynı tablet iki kez eklenmez.
const seen = new Map(); // mdns adı -> ilk görülme / son deneme zamanı
function watchWifi() {
  adb(['mdns', 'services'], (err, out) => {
    if (err && err.code === 'ENOENT') return;
    const now = Date.now();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+_adb-tls-connect\._tcp\.?\s+(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})\s*$/.exec(line.trim());
      if (!m) continue;
      const [, name, addr] = m;
      if ([...tablets].some((s) => s.startsWith(name + '.') || s === addr)) { seen.delete(name); continue; }
      if (!seen.has(name)) { seen.set(name, now); continue; } // önce adb'nin kendi bağlanmasına fırsat ver
      if (now - seen.get(name) < 15e3) continue;
      seen.set(name, now);
      adb(['connect', addr], (e, o) => { if (/connected to/i.test(o) && !/already/i.test(o)) console.log('[tablet] Wi-Fi ile bağlanıldı', addr); });
    }
    setTimeout(watchWifi, 10000);
  });
}

// --- Claude limitleri (gerçek yüzdeler). İki kaynak okunur, en yenisi geçerlidir:
// 1) data/claude-limits.json: bir Claude oturumunun ya da scripts/statusline.js'in yazdığı güncel değer.
// 2) Claude masaüstü uygulamasının kendi kullanım geçmişi (plan-usage-history.json): seyrek güncellenir.
const LIMITS = path.join(__dirname, '..', 'data', 'claude-limits.json');
function appHistory() {
  const bases = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'Claude')]
    : [path.join(process.env.LOCALAPPDATA || '', 'Claude-Data'), path.join(process.env.APPDATA || '', 'Claude')];
  let best = null;
  for (const base of bases) {
    let dirs = [];
    try { dirs = [base, ...fs.readdirSync(base).map((d) => path.join(base, d))]; } catch { continue; }
    for (const d of dirs) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(d, 'plan-usage-history.json'), 'utf8'));
        const s = o.samples[o.samples.length - 1];
        const pct = (v) => (typeof v === 'number' && v >= 0 && v <= 100 ? { used: v, resetsAt: null } : null);
        if (s && s.u && (!best || s.t > best.at)) best = { at: s.t, h5: pct(s.u.fh), d7: pct(s.u.sd) };
      } catch { /* bu klasörde yok */ }
    }
  }
  return best;
}
function sampleLimits() {
  let own = null;
  try {
    const o = JSON.parse(fs.readFileSync(LIMITS, 'utf8'));
    const ok = (w) => w && typeof w.used === 'number' && w.used >= 0 && w.used <= 100
      ? { used: w.used, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null } : null;
    if (typeof o.at === 'number') own = { at: o.at, h5: ok(o.h5), d7: ok(o.d7) };
  } catch { /* dosya yok ya da yarım yazılmış */ }
  const app = appHistory();
  const L = own && app ? (own.at >= app.at ? own : app) : own || app;
  // 5 saatlik pencere: 5 saatten eski ölçüm artık o pencereyi anlatmaz, yalnızca haftalık değer kalır.
  if (L && Date.now() - L.at > 5 * 3600e3) L.h5 = null;
  state.limits = L && (L.h5 || L.d7) && Date.now() - L.at < 24 * 3600e3 ? L : null;
}

// --- Ağ ayrıntısı: etkin bağdaştırıcı, yerel IP ve internete gecikme (10 sn'de bir tek ping) ---
function sampleNet() {
  const virt = /virtual|vethernet|vmware|vbox|wsl|loopback|docker|bluetooth|tailscale|utun|awdl|llw|bridge/i;
  let best = null;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const a = (addrs || []).find((x) => x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.'));
    if (a && (!best || (virt.test(best.name) && !virt.test(name)))) best = { name, ip: a.address };
  }
  state.netx.iface = best ? best.name : '';
  state.netx.ip = best ? best.ip : '';
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '1500', '1.1.1.1'] : ['-c', '1', '-W', '1500', '1.1.1.1'];
  execFile('ping', args, { windowsHide: true, timeout: 4000 }, (err, o) => {
    const m = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(String(o || ''));
    state.netx.online = !err && !!m;
    state.netx.ping = state.netx.online ? Math.round(parseFloat(m[1].replace(',', '.'))) : null;
  });
}

// --- Uygulama simgeleri (dock): çalışan programdan bir kez çıkarılır, data/icons içinde saklanır ---
const ICONS = path.join(__dirname, '..', 'data', 'icons');
const noIcon = new Set(); // simgesi çıkarılamayanlar yeniden denenmez
const iconJobs = new Map();
function sendIcon(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }).end(data);
  });
}
function serveIcon(name, res) {
  const win = state.windows.find((w) => w.name === name);
  if (!win || !/^[\p{L}\p{N} ._+-]{1,60}$/u.test(name) || !plat.icon || noIcon.has(name)) { res.writeHead(404).end(); return; }
  const file = path.join(ICONS, name + '.png');
  if (fs.existsSync(file)) { sendIcon(res, file); return; }
  let job = iconJobs.get(name);
  if (!job) {
    fs.mkdirSync(ICONS, { recursive: true });
    job = new Promise((resolve) => plat.icon(win.pid, file, (err) => { if (err) noIcon.add(name); iconJobs.delete(name); resolve(); }));
    iconJobs.set(name, job);
  }
  job.then(() => sendIcon(res, file));
}

// --- "PROJE ADIYLA" bildirim sesi: biten işin proje adı bilgisayarda seslendirilir, data/voices içinde saklanır ---
// Metni istemci gönderemez: yalnızca bildirim numarası gelir, cümleyi ajan kurar (n=test: örnek cümle).
const VOICES = path.join(__dirname, '..', 'data', 'voices');
const voiceJobs = new Map();
function serveVoice(n, res) {
  const no = state.notices.find((x) => String(x.id) === n);
  if (!plat.speak || (!no && n !== 'test')) { res.writeHead(404).end(); return; }
  const name = (no ? no.project : (state.bikorch && state.bikorch.projects[0] && state.bikorch.projects[0].name) || 'Bikorch Deck')
    .replace(/[^\p{L}\p{N} ._-]/gu, ' ').replace(/[-_.]+/g, ' ').trim().slice(0, 40) || 'proje';
  const text = no && no.outcome === 'error' ? `Eyvah! ${name} patladı!` : `${name} bitti kanka!`;
  const key = require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 16);
  const file = path.join(VOICES, key + (process.platform === 'win32' ? '.wav' : '.m4a'));
  const send = (type) => fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': type || (file.endsWith('.wav') ? 'audio/wav' : 'audio/mp4'), 'Cache-Control': 'max-age=3600' }).end(data);
  });
  if (fs.existsSync(file)) { send(); return; }
  let job = voiceJobs.get(key);
  if (!job) {
    fs.mkdirSync(VOICES, { recursive: true });
    job = new Promise((resolve) => plat.speak(text, file, (err, type) => { voiceJobs.delete(key); resolve(err ? null : type); }));
    voiceJobs.set(key, job);
  }
  job.then((type) => (type ? send(type) : res.writeHead(404).end()));
}

// --- Kendi seslerin: data/sounds klasörüne atılan ses dosyaları seçme ekranında görünür ---
// Tablet yalnızca listedeki anahtarı ister; yol gönderemez.
const MYSOUNDS = path.join(__dirname, '..', 'data', 'sounds');
const AUDIO = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac' };
const TR = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u' };
function mySounds() {
  let names = [];
  try { names = fs.readdirSync(MYSOUNDS); } catch { return []; }
  const out = [], used = new Set();
  for (const f of names.sort()) {
    if (!AUDIO[path.extname(f).toLowerCase()]) continue;
    const base = path.basename(f, path.extname(f));
    let slug = base.toLocaleLowerCase('tr').replace(/[çğıöşü]/g, (c) => TR[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ses';
    while (used.has(slug)) slug += 'x';
    used.add(slug);
    out.push({ key: 'my-' + slug, name: base.slice(0, 40), file: f });
  }
  return out.slice(0, 60);
}

// --- Yayın ---
const clients = new Set();
function tick() {
  sampleCpu();
  push('cpu', state.cpu.total);
  push('mem', Math.round((state.mem.used / state.mem.total) * 1000) / 10);
  push('gpu', state.gpu ? state.gpu.util : 0);
  push('rx', state.net.rx); push('tx', state.net.tx);
  state.netx.totRx += state.net.rx; state.netx.totTx += state.net.tx; // ajan başladığından beri
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
}

// --- HTTP ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.m4a': 'audio/mp4', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const sendJson = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
// JSON şartı: başka sitelerin bu uçlara gizlice istek atmasını (CSRF) engeller.
const isJson = (req) => /^application\/json/.test(req.headers['content-type'] || '');

function readJson(req, cb, max = 16384) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > max) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ state, hist, layout: loadLayout(), ...profInfo(loadProfiles()) })}\n\n`);
    clients.add(res);
    const android = /Android/i.test(req.headers['user-agent'] || '');
    if (android) androidClients++;
    req.on('close', () => { clients.delete(res); if (android) androidClients--; });
    return;
  }
  if (url.pathname === '/api/focus' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const hwnd = o && o.hwnd;
      if (!Number.isSafeInteger(hwnd) || !state.windows.some((w) => w.hwnd === hwnd)) { sendJson(res, 400, { ok: false }); return; }
      plat.focus(hwnd, (err) => sendJson(res, err ? 500 : 200, { ok: !err }));
    });
    return;
  }
  // Müzik: ileri / geri / duraklat-devam (yalnızca bu üç komut).
  if (url.pathname === '/api/media' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const cmd = o && o.cmd;
      if (!plat.media || !['next', 'prev', 'toggle'].includes(cmd)) { sendJson(res, 400, { ok: false }); return; }
      plat.media(cmd, (err) => sendJson(res, err ? 500 : 200, { ok: !err }));
    });
    return;
  }
  // Bilgisayarın ses düzeyi: { vol: 0..100 } ve/veya { mute: true|false }.
  if (url.pathname === '/api/volume' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const cmd = {};
      if (o && Number.isInteger(o.vol) && o.vol >= 0 && o.vol <= 100) cmd.vol = o.vol;
      if (o && typeof o.mute === 'boolean') cmd.mute = o.mute;
      if (!plat.volume || !Object.keys(cmd).length) { sendJson(res, 400, { ok: false }); return; }
      plat.volume(cmd, (err) => sendJson(res, err ? 500 : 200, { ok: !err }));
    });
    return;
  }
  // Bikorch uygulaması bir CLI işi bitince buraya haber verir.
  if (url.pathname === '/api/bikorch/notice' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const n = bikorch.parseNotice(o);
      if (!n) { sendJson(res, 400, { ok: false }); return; }
      notice(n);
      sendJson(res, 200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/api/profile' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      let r = null;
      try { r = profileOp(o); } catch (e) { console.error('[profil]', e.message); }
      sendJson(res, r ? 200 : 400, r ? { ok: true, ...r } : { ok: false });
    });
    return;
  }
  if (url.pathname === '/api/layout' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const layout = cleanLayout(o);
      if (!layout) { sendJson(res, 400, { ok: false }); return; }
      try {
        fs.mkdirSync(path.dirname(LAYOUT), { recursive: true });
        fs.writeFileSync(LAYOUT, JSON.stringify(layout, null, 1));
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 500, { ok: false }); }
    });
    return;
  }
  if (url.pathname === '/api/clean/scan' && req.method === 'GET') {
    const one = url.searchParams.get('id');
    clean.run(plat, 'scan', CLEAN_IDS.includes(one) ? [one] : CLEAN_IDS)
      .then((items) => sendJson(res, 200, { ok: true, items }), () => sendJson(res, 500, { ok: false, items: [] }));
    return;
  }
  if (url.pathname === '/api/clean' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      const ids = o && Array.isArray(o.targets) ? o.targets.filter((t) => CLEAN_IDS.includes(t)) : [];
      if (!ids.length) { sendJson(res, 400, { ok: false }); return; }
      clean.run(plat, 'clean', ids).then((items) => {
        console.log('[temizlik]', items.map((i) => `${i.id}: ${i.removed} öğe, ${Math.round(i.freed / 2 ** 20)} MB`).join(' | '));
        sendJson(res, 200, { ok: true, items });
        measure();
      }, () => sendJson(res, 500, { ok: false, items: [] }));
    });
    return;
  }
  // Nöbet modu (server/guard.js): ayarlar şifreyle değişir; fotoğraflar bu bilgisayarda kalır.
  if (url.pathname === '/api/guard' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      let r = null;
      try { r = guard.op(o, plat); } catch (e) { console.error('[nöbet]', e.message); }
      sendJson(res, r ? 200 : 400, r || { ok: false });
    }, 256 * 1024);
    return;
  }
  if (url.pathname === '/api/guard/alert' && req.method === 'POST') {
    if (!isJson(req)) { res.writeHead(415).end(); return; }
    readJson(req, (o) => {
      let r = null;
      try { r = guard.alert(o, plat); } catch (e) { console.error('[nöbet]', e.message); }
      sendJson(res, r ? 200 : 400, r || { ok: false });
    }, 4 * 1024 * 1024);
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (url.pathname === '/api/guard') { sendJson(res, 200, guard.info()); return; }
  if (url.pathname.startsWith('/guard/shot/')) {
    const p = guard.shot(url.pathname.slice(12));
    if (!p) { res.writeHead(404).end(); return; }
    fs.readFile(p, (err, data) => err ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }).end(data));
    return;
  }
  if (url.pathname === '/media/art') {
    fs.readFile(plat.mediaArt || '', (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': data[0] === 0x89 ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' }).end(data);
    });
    return;
  }
  if (url.pathname === '/api/sounds') { sendJson(res, 200, mySounds().map(({ key, name }) => ({ key, name }))); return; }
  if (url.pathname.startsWith('/mysound/')) {
    const s = mySounds().find((x) => x.key === url.pathname.slice(9));
    if (!s) { res.writeHead(404).end(); return; }
    fs.readFile(path.join(MYSOUNDS, s.file), (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': AUDIO[path.extname(s.file).toLowerCase()], 'Cache-Control': 'no-cache' }).end(data);
    });
    return;
  }
  if (url.pathname === '/voice') { serveVoice(url.searchParams.get('n') || '', res); return; }
  if (url.pathname.startsWith('/icon/')) { serveIcon(decodeURIComponent(url.pathname.slice(6)), res); return; }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('yok'); return; }
    // Yüz tanıma modelleri (~7 MB) değişmez: tablet her açılışta yeniden indirmesin.
    const cache = rel.startsWith('vendor/') ? 'max-age=2592000' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
});

// Ajan gizli çalışır; beklenmeyen bir hata tableti karartmasın: günlüğe yaz, çalışmayı sürdür.
process.on('uncaughtException', (e) => console.error('[hata]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[hata]', e && e.stack || e));

// Port doluysa ajan zaten çalışıyordur; ikinci kopya sessizce çıkar.
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? 'Bikorch Deck zaten çalışıyor.' : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  console.log(`${new Date().toLocaleString('tr-TR')} Bikorch Deck hazır (${process.platform}): http://${HOST}:${PORT}`);
  plat.startCollector(state);
  if (plat.startMedia) plat.startMedia(state);
  plat.sampleGpu(state); sampleClaude();
  setInterval(tick, 1000);
  setInterval(() => plat.sampleGpu(state), 2000);
  setInterval(sampleClaude, 3000);
  watchTablet();
  watchWifi();
  sampleNet(); sampleLimits();
  setInterval(sampleLimits, 15000);
  setInterval(sampleNet, 10000);
  setTimeout(measure, 15000);
  setInterval(measure, 20 * 60e3);
});
