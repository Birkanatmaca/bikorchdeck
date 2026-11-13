// Bikorch masaüstü uygulamasıyla bağlantı.
// 1) Bikorch'un kendi veritabanını (workspace.db) SALT OKUNUR açar: projeler, aktif proje, hesap limitleri.
// 2) Claude Code oturumlarını projelere eşler: hangi projede iş sürüyor, hangisinde bitti.
// 3) Bikorch'un doğrudan gönderdiği bildirimleri kabul eder (POST /api/bikorch/notice).
const fs = require('fs');
const path = require('path');
const os = require('os');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* eski Node: yalnızca Claude oturumları gösterilir */ }

const DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Bikorch')
  : path.join(process.env.APPDATA || os.homedir(), 'Bikorch');
const DB = path.join(DIR, 'workspace.db');

const WT = path.join(DIR, 'agent-worktrees');
const EMPTY = () => ({ installed: false, at: 0, projects: [], activeId: null, usage: [], repos: new Map() });
let db = EMPTY();
let seen = -1;

function readDb() {
  let st;
  try { st = fs.statSync(DB); } catch { db = EMPTY(); seen = -1; return; }
  if (!sqlite || st.mtimeMs === seen) return;
  let h;
  try {
    h = new sqlite.DatabaseSync(DB, { readOnly: true });
    const meta = (k) => { const r = h.prepare('select value from meta where key = ?').get(k); return r ? r.value : null; };
    const projects = h.prepare('select id, name, folder_path from projects order by sort_order').all()
      .map((p) => ({ id: p.id, name: p.name, folder: p.folder_path || '' }));
    let usage = [];
    try {
      const u = JSON.parse(meta('ai_usage') || '{}');
      const win = (w) => w && typeof w.usedPercent === 'number'
        ? { label: String(w.label || ''), used: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
          reset: String(w.resetLabel || '').slice(0, 60) } : null;
      usage = (u.providers || []).filter((p) => p.status === 'available').map((p) => ({
        kind: String(p.kind), plan: String(p.planType || ''), primary: win(p.primary), secondary: win(p.secondary),
        at: (u.checkedAtByAccountId || {})[p.accountId] || 0,
      })).filter((p) => p.primary);
    } catch { /* kullanım kaydı yoksa boş kalır */ }
    // Bikorch her terminale ayrı çalışma klasörü açar: agent-worktrees/<repo_hash>/<dal>. Hash -> asıl depo klasörü.
    const repos = new Map();
    try {
      for (const r of h.prepare('select repo_hash, repo_root from agent_isolation_state').all()) repos.set(r.repo_hash, r.repo_root);
    } catch { /* eski Bikorch sürümü: tablo yok */ }
    db = { installed: true, at: st.mtimeMs, projects, activeId: meta('active_project_id'), usage, repos };
    seen = st.mtimeMs;
  } catch { /* Bikorch dosyayı o an yazıyor olabilir; sonraki turda yeniden denenir */ }
  finally { try { if (h) h.close(); } catch { /* kapalı */ } }
}

const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

// Bikorch çalışma klasöründeki bir yolu asıl depo klasörüne çevirir; diğer yollar olduğu gibi kalır.
function realCwd(cwd) {
  if (!cwd) return cwd;
  const rel = path.relative(WT, path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return cwd;
  const parts = rel.split(path.sep); // [repo_hash, dal, ...alt klasör]
  const root = db.repos.get(parts[0]);
  return root ? path.join(root, ...parts.slice(2)) : cwd;
}

// Bikorch'un kendi iç işleri (ana sayfa sohbeti, brifing, yönetici...) uygulama klasöründe çalışır; proje değildir.
function internal(cwd) {
  if (!cwd) return false;
  const rel = path.relative(DIR, path.resolve(cwd));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== 'agent-worktrees';
}

// Bir oturum klasörünün ait olduğu Bikorch projesinin adı (yoksa klasör adı).
function projectName(cwd, fallback) {
  readDb();
  const c = realCwd(cwd);
  if (!c) return fallback;
  const n = norm(c);
  const p = db.projects.find((x) => x.folder && (n === norm(x.folder) || n.startsWith(norm(x.folder) + path.sep)));
  return p ? p.name : path.basename(c) || fallback;
}
const RANK = { calisiyor: 0, tamam: 1, bosta: 2 };

// work: Claude oturumları [{cwd, project, title, status, last, turnMs}]; running: Bikorch penceresi açık mı.
function snapshot(work, running) {
  readDb();
  const rows = new Map();
  for (const p of db.projects) {
    rows.set(p.folder ? norm(p.folder) : p.id, { name: p.name, bikorch: true, current: p.id === db.activeId, status: 'bosta', n: 0, last: 0, title: '', src: '' });
  }
  const keys = [...rows.keys()];
  for (const s of work || []) {
    if (internal(s.cwd)) continue;
    const cwd = s.cwd ? norm(realCwd(s.cwd)) : s.project;
    // Alt klasörde açılmış oturum da üst projeye sayılır.
    const key = keys.find((k) => cwd === k || cwd.startsWith(k + path.sep)) || cwd;
    let r = rows.get(key);
    if (!r) { r = { name: s.cwd ? path.basename(realCwd(s.cwd)) : s.project, bikorch: false, current: false, status: 'bosta', n: 0, last: 0, title: '', src: '' }; rows.set(key, r); }
    r.n++;
    // Satırda en önemli oturum görünür: önce çalışan, sonra en yeni. src: o işi yapan ajan (claude / codex).
    const better = RANK[s.status] < RANK[r.status] || (RANK[s.status] === RANK[r.status] && s.last > r.last);
    if (RANK[s.status] < RANK[r.status]) r.status = s.status;
    if (better) { r.src = s.src || ''; r.title = s.title || ''; }
    if (s.last > r.last) r.last = s.last;
  }
  const projects = [...rows.values()]
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.current - a.current || b.last - a.last).slice(0, 12);
  return { installed: db.installed, running: !!running, dbAt: db.at, projects, usage: db.usage };
}

// Bikorch'tan gelen bildirimi doğrular; yalnızca kısa düz metin alanları kabul edilir.
function parseNotice(o) {
  const s = (v, max) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  if (!o || (o.outcome !== 'done' && o.outcome !== 'error')) return null;
  const project = s(o.projectName, 80), title = s(o.title, 80);
  if (!project) return null;
  return { project, title: s(o.heading, 120) || title, src: title || 'Bikorch', outcome: o.outcome };
}

module.exports = { snapshot, parseNotice, projectName, internal };
