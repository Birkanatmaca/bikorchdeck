// Claude Code oturum kayıtlarını (~/.claude/projects/**/*.jsonl) okuyup kullanım özeti çıkarır.
// Dosyalar artımlı okunur: her taramada yalnızca yeni eklenen baytlar işlenir.
// Kayıtlar GB'larca olabilir (tek oturum yüzlerce MB): yalnızca son 7 günde değişen dosyalar, parça parça okunur;
// çok uzun satırlar (dev araç çıktıları) çözülmez. Yoksa ilk tarama dakikalar sürer ve ajan o sırada donar.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Kayıtlar iki yerde olabilir: Claude Code'un kendi klasörü ve Bikorch'un hesap başına ayırdığı profil klasörleri
// (Bikorch terminalleri CLAUDE_CONFIG_DIR = .../Bikorch/cli-profiles/claude/<hesap> ile çalışır).
const BIKORCH = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Bikorch')
  : path.join(process.env.APPDATA || os.homedir(), 'Bikorch');
function roots() {
  const out = [path.join(os.homedir(), '.claude', 'projects')];
  const prof = path.join(BIKORCH, 'cli-profiles', 'claude');
  try { for (const d of fs.readdirSync(prof)) out.push(path.join(prof, d, 'projects')); } catch { /* Bikorch yok */ }
  return out;
}
const files = new Map(); // yol -> { offset, rem, msgs, cwd, mtime, sub, phase, turnAt, endAt, title, status }
let primed = false; // ilk taramada eski oturumlar için "bitti" bildirimi üretilmez

const WEEK = 7 * 86400e3, CHUNK = 4 << 20, TAIL = 48 << 20, LONG = 512 << 10;

function walk(dir, since, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch { /* silinmiş */ } }
  }
}

function ingest(p) {
  const st = fs.statSync(p);
  let f = files.get(p);
  if (!f || st.size < f.offset) {
    f = { offset: 0, rem: Buffer.alloc(0), msgs: new Map(), cwd: null, mtime: 0, sub: /subagents/i.test(p) };
    files.set(p, f);
  }
  f.mtime = st.mtimeMs;
  if (st.size === f.offset) return;
  let from = f.offset;
  // İlk kez görülen dev dosya: yalnızca son TAIL bayt (ilk yarım satır atlanır). Eski kullanım biraz eksik sayılabilir.
  if (from === 0 && st.size > TAIL) { from = st.size - TAIL; f.skip = true; }
  const fd = fs.openSync(p, 'r');
  try {
    for (let pos = from; pos < st.size; pos += CHUNK) {
      const n = Math.min(CHUNK, st.size - pos), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos);
      chunk(f, buf, st.mtimeMs);
    }
  } finally { fs.closeSync(fd); }
  f.offset = st.size;
}

function chunk(f, buf, mtime) {
  const all = f.rem.length ? Buffer.concat([f.rem, buf]) : buf;
  let start = 0;
  for (;;) {
    const nl = all.indexOf(0x0a, start);
    if (nl < 0) break;
    const s0 = start;
    start = nl + 1;
    if (f.skip) { f.skip = false; continue; }
    // Dev satırlar araç çıktısıdır (dosya içeriği, ekran görüntüsü...): durumu değiştirmez, kullanım bilgisi taşımaz.
    if (nl - s0 < 2 || nl - s0 > LONG) continue;
    line(f, all.toString('utf8', s0, nl), mtime);
  }
  f.rem = all.subarray(start);
  if (f.rem.length > LONG) { f.rem = Buffer.alloc(0); f.skip = true; } // biten satırın kalanı da atlanır
}

function line(f, text, mtime) {
  {
    let o;
    try { o = JSON.parse(text); } catch { return; }
    if (o.cwd) f.cwd = o.cwd;
    // Son gerçek etkinlik: zaman damgalı her kayıt. Dosyanın değişme zamanı yetmez; Claude Code oturumu yeniden
    // bağlarken eski dosyalara zaman damgasız ayar satırları (permission-mode, session-owner...) ekler.
    if (o.timestamp) f.actAt = Math.max(f.actAt || 0, Date.parse(o.timestamp) || 0);
    if (o.type === 'custom-title' && o.customTitle) f.title = String(o.customTitle).slice(0, 80);
    const m = o.message;
    // Tur durumu: kullanıcı mesajı ya da araç çağrısı -> iş sürüyor; yanıt araçsız bittiyse -> tur tamam.
    if (m && !o.isSidechain && !o.isMeta) {
      const t = Date.parse(o.timestamp) || mtime;
      if (o.type === 'user') {
        if (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'text'))) f.turnAt = t;
        f.phase = 'work';
      } else if (o.type === 'assistant') {
        f.phase = m.stop_reason && m.stop_reason !== 'tool_use' && m.stop_reason !== 'pause_turn' ? 'done' : 'work';
        f.endAt = t;
      }
    }
    if (o.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') return;
    const u = m.usage;
    // Aynı mesaj akış sırasında birden çok kez yazılır; son kayıt geçerli.
    f.msgs.set(m.id || o.uuid, {
      t: Date.parse(o.timestamp) || mtime,
      model: m.model || '?',
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
      cw: u.cache_creation_input_tokens || 0,
    });
  }
}

const bucket = () => ({ in: 0, out: 0, cr: 0, cw: 0, n: 0 });
const add = (b, m) => { b.in += m.in; b.out += m.out; b.cr += m.cr; b.cw += m.cw; b.n++; };

function snapshot() {
  const list = [];
  for (const r of roots()) walk(r, Date.now() - WEEK, list);
  for (const p of list) { try { ingest(p); } catch { /* dosya o an kilitli olabilir */ } }
  for (const [p, f] of files) if (Date.now() - f.mtime > WEEK) files.delete(p); // bir haftadır değişmeyen: bellekten çık

  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const h5 = bucket(), today = bucket(), d7 = bucket();
  const hourly = new Array(24).fill(0);
  const byModel = {};
  const sessions = [], work = [], events = [];

  for (const [p, f] of files) {
    let last = 0, out = 0, model = null;
    for (const m of f.msgs.values()) {
      const age = now - m.t;
      if (age < 5 * 3600e3) add(h5, m);
      if (m.t >= midnight.getTime()) {
        add(today, m);
        (byModel[m.model] ||= bucket()); add(byModel[m.model], m);
      }
      if (age < 7 * 86400e3) add(d7, m);
      const hi = Math.floor(age / 3600e3);
      if (hi >= 0 && hi < 24) hourly[23 - hi] += m.out;
      if (m.t > last) { last = m.t; model = m.model; }
      out += m.out;
    }
    if (!f.sub && last) {
      const project = f.cwd ? path.basename(f.cwd) : path.basename(path.dirname(p));
      // Kayıt 15 dakikadır değişmediyse yarıda bırakılmış sayılır.
      const status = f.phase === 'done' ? 'tamam' : now - (f.actAt || f.mtime) < 15 * 60e3 ? 'calisiyor' : 'bosta';
      const turnMs = f.turnAt && f.endAt > f.turnAt ? f.endAt - f.turnAt : 0;
      if (primed && f.status === 'calisiyor' && status === 'tamam' && turnMs >= 5000) {
        events.push({ cwd: f.cwd, project, title: f.title || '', src: 'Claude', outcome: 'done', ms: turnMs });
      }
      f.status = status;
      const s = { id: path.basename(p, '.jsonl').slice(0, 8), cwd: f.cwd, project, title: f.title || '', status, model, last, out, n: f.msgs.size,
        active: status === 'calisiyor' };
      sessions.push(s);
      const act = Math.max(last, f.endAt || 0, f.turnAt || 0);
      if (status === 'calisiyor' || now - act < 3 * 86400e3) work.push({ cwd: f.cwd, project, title: s.title, status, last: act, turnMs });
    }
  }
  primed = true;
  sessions.sort((a, b) => b.active - a.active || b.last - a.last);
  return {
    usage: { h5, today, d7, hourly, byModel, sessions: sessions.slice(0, 8), activeCount: sessions.filter((s) => s.active).length, at: now },
    work, events,
  };
}

module.exports = { snapshot };
