// ChatGPT Codex oturum kayıtlarını (~/.codex/sessions/**/rollout-*.jsonl) okur: hangi projede iş sürüyor,
// hangisi bitti, token kullanımı ve Codex limitleri. Codex masaüstü, VS Code ve CLI aynı klasöre yazar;
// Bikorch'un Codex terminalleri kendi profil klasörüne (Bikorch/cli-profiles/codex/<hesap>/sessions) yazar.
//
// Kayıtlar çok büyüyebilir (araç çıktıları da içinde; tek dosya yüzlerce MB olabiliyor). Bu yüzden:
// - yalnızca son 7 günde değişmiş dosyalar okunur,
// - bir dosya ilk kez görülünce başı (oturum bilgisi, ilk istek) ve son birkaç MB'ı okunur, sonra yalnızca eklenenler,
// - satırın yalnızca ilk birkaç yüz karakterine bakılır; işe yarayan türler dışındaki satırlar JSON olarak hiç çözülmez.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIKORCH = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Bikorch')
  : path.join(process.env.APPDATA || os.homedir(), 'Bikorch');
const HEAD = 1 << 20, TAIL = 8 << 20, CHUNK = 4 << 20;
const WEEK = 7 * 86400e3, STALE = 15 * 60e3;

function roots() {
  const out = [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')];
  const prof = path.join(BIKORCH, 'cli-profiles', 'codex');
  try { for (const d of fs.readdirSync(prof)) out.push(path.join(prof, d, 'sessions')); } catch { /* Bikorch yok */ }
  return out;
}

function walk(dir, since, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, since, out);
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch { /* silinmiş */ } }
  }
}

// Satırın türü baştan okunur: {"timestamp":..,"ordinal":..,"type":"event_msg","payload":{"type":"task_complete"...
const KINDS = /"type":"(session_meta|turn_context)"|"payload":\{"type":"(task_started|task_complete|turn_aborted|token_count|thread_settings_applied|item_completed)"/;
const files = new Map();
let primed = false; // ilk taramada eski işler için bildirim üretilmez
let limits = null; // en son görülen Codex limitleri

const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function handle(f, o, quiet) {
  const p = o.payload || {};
  const t = Date.parse(o.timestamp) || Date.now();
  if (o.type === 'session_meta') { f.cwd = p.cwd || f.cwd; f.src = p.originator || p.source || ''; return; }
  if (o.type === 'turn_context') { if (p.cwd) f.cwd = p.cwd; if (p.model) f.model = p.model; return; }
  switch (p.type) {
    case 'thread_settings_applied':
      if (p.thread_settings && p.thread_settings.model) f.model = p.thread_settings.model;
      break;
    case 'item_completed': {
      const it = p.item;
      if (!it || it.type !== 'UserMessage') break;
      const text = short((it.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' '), 90);
      if (text && !f.title) f.title = text;
      if (text) f.prompt = text;
      break;
    }
    case 'task_started':
      f.phase = 'work'; f.turnAt = (p.started_at * 1000) || t; f.lastAt = t;
      break;
    case 'task_complete': {
      const ms = p.duration_ms || (f.turnAt ? t - f.turnAt : 0);
      const was = f.phase;
      f.phase = 'done'; f.endAt = t; f.lastAt = t; f.turnMs = ms; f.done.push(t);
      // Yanıt Markdown'dır; tablette düz yazı gösterilir (kalın, kod, başlık, bağlantı işaretleri atılır).
      f.reply = short(String(p.last_agent_message || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, ''), 160);
      if (!quiet && was === 'work' && ms >= 5000) f.events.push({ ms, reply: f.reply });
      break;
    }
    case 'turn_aborted': // kullanıcı durdurdu: bildirim yok, oturum boşta sayılır
      f.phase = 'idle'; f.endAt = t; f.lastAt = t;
      break;
    case 'token_count': {
      f.lastAt = t;
      const r = p.rate_limits;
      if (r && r.primary && (!limits || t >= limits.at)) {
        const w = (x) => x && typeof x.used_percent === 'number'
          ? { used: x.used_percent, resetsAt: x.resets_at ? x.resets_at * 1000 : null, mins: x.window_minutes || 0 } : null;
        limits = { at: t, plan: r.plan_type || '', h5: w(r.primary), d7: w(r.secondary) };
      }
      const tot = p.info && p.info.total_token_usage;
      if (!tot) break;
      // Toplam sayaç oturum boyunca artar; artış kadarı o ana yazılır (dosyanın ortasından okumaya başladıysak ilk değer taban olur).
      if (f.total && tot.total_tokens > f.total.total_tokens) {
        f.usage.push({ t, out: Math.max(0, tot.output_tokens - f.total.output_tokens), in: Math.max(0, tot.input_tokens - f.total.input_tokens) });
      }
      if (!f.total || tot.total_tokens >= f.total.total_tokens) f.total = tot;
      break;
    }
  }
}

function lines(f, buf, quiet) {
  const all = f.rem.length ? Buffer.concat([f.rem, buf]) : buf;
  let start = 0;
  for (;;) {
    const nl = all.indexOf(0x0a, start);
    if (nl < 0) break;
    if (f.skip) f.skip = false; // ortadan başlanan okumanın ilk yarım satırı atlanır
    else {
      const head = all.toString('utf8', start, Math.min(nl, start + 400));
      const ts = /^\{"timestamp":"([^"]+)"/.exec(head); // her satırın zamanı: son gerçek etkinlik
      if (ts) f.actAt = Math.max(f.actAt, Date.parse(ts[1]) || 0);
      if (KINDS.test(head)) { try { handle(f, JSON.parse(all.toString('utf8', start, nl)), quiet); } catch { /* yarım satır */ } }
    }
    start = nl + 1;
  }
  f.rem = all.subarray(start);
  if (f.rem.length > 64 << 20) f.rem = Buffer.alloc(0); // aşırı uzun tek satır: belleği şişirmesin
}

function readRange(fd, f, from, to, quiet) {
  for (let pos = from; pos < to; pos += CHUNK) {
    const n = Math.min(CHUNK, to - pos), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, pos);
    lines(f, buf, quiet);
  }
}

function ingest(p) {
  const st = fs.statSync(p);
  let f = files.get(p);
  if (!f || st.size < f.offset) {
    f = { offset: 0, rem: Buffer.alloc(0), skip: false, cwd: null, src: '', model: null, title: '', prompt: '', reply: '',
      phase: null, actAt: 0, turnAt: 0, endAt: 0, lastAt: 0, turnMs: 0, done: [], total: null, usage: [], events: [], status: null, mtime: 0 };
    files.set(p, f);
  }
  f.mtime = st.mtimeMs;
  if (st.size === f.offset) return;
  const fd = fs.openSync(p, 'r');
  try {
    if (f.offset === 0 && st.size > HEAD + TAIL) {
      // İlk okuma, büyük dosya: baş (oturum bilgisi + ilk istek) ve son TAIL bayt. Aradaki eski olaylar sessizce atlanır.
      readRange(fd, f, 0, HEAD, true);
      f.rem = Buffer.alloc(0); f.skip = true;
      readRange(fd, f, st.size - TAIL, st.size, true);
    } else readRange(fd, f, f.offset, st.size, f.offset === 0);
  } finally { fs.closeSync(fd); }
  f.offset = st.size;
}

function snapshot() {
  const now = Date.now();
  const list = [];
  for (const r of roots()) walk(r, now - WEEK, list);
  for (const p of list) { try { ingest(p); } catch { /* o an yazılıyor olabilir */ } }

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const today = { in: 0, out: 0, turns: 0 }, h5 = { in: 0, out: 0 };
  const hourly = new Array(24).fill(0);
  const sessions = [], work = [], events = [];
  for (const [p, f] of files) {
    if (now - f.mtime > WEEK) { files.delete(p); continue; }
    f.usage = f.usage.filter((u) => now - u.t < WEEK);
    for (const u of f.usage) {
      const age = now - u.t;
      if (u.t >= midnight.getTime()) { today.in += u.in; today.out += u.out; }
      if (age < 5 * 3600e3) { h5.in += u.in; h5.out += u.out; }
      const hi = Math.floor(age / 3600e3);
      if (hi >= 0 && hi < 24) hourly[23 - hi] += u.out;
    }
    f.done = f.done.filter((t) => now - t < WEEK);
    today.turns += f.done.filter((t) => t >= midnight.getTime()).length;
    if (!f.cwd && !f.title) continue; // henüz başı okunmamış
    // Çalışıyor görünüp kayıt 15 dakikadır hiç değişmediyse yarıda kalmış sayılır.
    const status = f.phase === 'work' ? (now - (f.actAt || f.mtime) < STALE ? 'calisiyor' : 'bosta') : f.phase === 'done' ? 'tamam' : 'bosta';
    const project = f.cwd ? path.basename(f.cwd) : '?';
    if (primed) for (const e of f.events) events.push({ cwd: f.cwd, project, title: f.title, src: 'Codex', outcome: 'done', ms: e.ms, reply: e.reply });
    f.events = [];
    f.status = status;
    const last = Math.max(f.lastAt, f.endAt, f.turnAt) || f.mtime;
    sessions.push({ id: path.basename(p, '.jsonl').slice(-8), cwd: f.cwd, project, title: f.title, prompt: f.prompt, reply: f.reply,
      status, model: f.model, last, since: status === 'calisiyor' ? f.turnAt : 0, turnMs: f.turnMs,
      out: f.total ? f.total.output_tokens : 0, tokens: f.total ? f.total.total_tokens : 0, app: f.src });
    if (status === 'calisiyor' || now - last < 3 * 86400e3) work.push({ cwd: f.cwd, project, title: f.title, status, last, turnMs: f.turnMs, src: 'codex' });
  }
  if (!primed) for (const f of files.values()) f.events = [];
  primed = true;
  sessions.sort((a, b) => (b.status === 'calisiyor') - (a.status === 'calisiyor') || b.last - a.last);
  // 5 saatlik pencere sıfırlandıysa eski yüzde artık geçerli değildir.
  const lim = limits && {
    plan: limits.plan, at: limits.at,
    h5: limits.h5 && (!limits.h5.resetsAt || limits.h5.resetsAt > now) ? limits.h5 : null,
    d7: limits.d7 && (!limits.d7.resetsAt || limits.d7.resetsAt > now) ? limits.d7 : null,
  };
  return {
    usage: { today, h5, hourly, sessions: sessions.slice(0, 10), activeCount: sessions.filter((s) => s.status === 'calisiyor').length,
      limits: lim && (lim.h5 || lim.d7) ? lim : null, at: now, found: files.size > 0 },
    work, events,
  };
}

module.exports = { snapshot };
