// Claude Code oturum kayıtlarını (~/.claude/projects/**/*.jsonl) okuyup kullanım özeti çıkarır.
// Dosyalar artımlı okunur: her taramada yalnızca yeni eklenen baytlar işlenir.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const files = new Map(); // yol -> { offset, rem, msgs, cwd, mtime, sub, phase, turnAt, endAt, title, status }
let primed = false; // ilk taramada eski oturumlar için "bitti" bildirimi üretilmez

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
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
  const buf = Buffer.alloc(st.size - f.offset);
  const fd = fs.openSync(p, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, f.offset); } finally { fs.closeSync(fd); }
  f.offset = st.size;
  const all = Buffer.concat([f.rem, buf]);
  const cut = all.lastIndexOf(0x0a);
  if (cut < 0) { f.rem = all; return; }
  f.rem = all.subarray(cut + 1);
  for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) f.cwd = o.cwd;
    if (o.type === 'custom-title' && o.customTitle) f.title = String(o.customTitle).slice(0, 80);
    const m = o.message;
    // Tur durumu: kullanıcı mesajı ya da araç çağrısı -> iş sürüyor; yanıt araçsız bittiyse -> tur tamam.
    if (m && !o.isSidechain && !o.isMeta) {
      const t = Date.parse(o.timestamp) || st.mtimeMs;
      if (o.type === 'user') {
        if (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((c) => c.type === 'text'))) f.turnAt = t;
        f.phase = 'work';
      } else if (o.type === 'assistant') {
        f.phase = m.stop_reason && m.stop_reason !== 'tool_use' && m.stop_reason !== 'pause_turn' ? 'done' : 'work';
        f.endAt = t;
      }
    }
    if (o.type !== 'assistant' || !m || !m.usage || m.model === '<synthetic>') continue;
    const u = m.usage;
    // Aynı mesaj akış sırasında birden çok kez yazılır; son kayıt geçerli.
    f.msgs.set(m.id || o.uuid, {
      t: Date.parse(o.timestamp) || f.mtime,
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
  walk(ROOT, list);
  for (const p of list) { try { ingest(p); } catch { /* dosya o an kilitli olabilir */ } }

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
      const status = f.phase === 'done' ? 'tamam' : now - f.mtime < 15 * 60e3 ? 'calisiyor' : 'bosta';
      const turnMs = f.turnAt && f.endAt > f.turnAt ? f.endAt - f.turnAt : 0;
      if (primed && f.status === 'calisiyor' && status === 'tamam' && turnMs >= 5000) {
        events.push({ project, title: f.title || '', src: 'Claude', outcome: 'done', ms: turnMs });
      }
      f.status = status;
      const s = { id: path.basename(p, '.jsonl').slice(0, 8), project, title: f.title || '', status, model, last, out, n: f.msgs.size,
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
