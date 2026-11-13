// Temizlik (her iki sistemde ortak): sabit önbellek klasörlerini tarar veya siler.
// Hedef listesi platform modülünden gelir; istemci yalnızca hedef adı gönderebilir, yol gönderemez.
const fsp = require('fs').promises;
const path = require('path');

// İşler sıraya girer: arka plandaki ölçüm sürerken tabletten gelen istek beklemeye alınır.
let chain = Promise.resolve();

// Sembolik bağ ve junction'lar izlenmez (Dirent bunları klasör saymaz), yani tarama önbellek klasörünün dışına çıkamaz.
async function walk(roots, days, onFile) {
  const limit = Date.now() - days * 86400e3;
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) files.push(p);
    }
    // Dosyalar 64'lük gruplar halinde paralel işlenir (tek tek beklemek çok yavaş).
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map(async (p) => {
        let st;
        try { st = await fsp.lstat(p); } catch { return; }
        if (days <= 0 || st.mtimeMs < limit) await onFile(p, used(st));
      }));
    }
  }
}

// Diskte gerçekten kaplanan alan: macOS'ta dosya boyutu yanıltır (APFS seyrek / sıkıştırılmış dosyalar, 4 KB bloklar).
// Başka yerden de bağlı (hard link, ör. pnpm deposu) dosya silinince yer açılmaz; 0 sayılır. Windows'ta blok bilgisi yok.
const used = (st) => process.platform === 'win32' || !st.blocks && st.blocks !== 0 ? st.size : st.nlink > 1 ? 0 : st.blocks * 512;

async function one(plat, mode, id) {
  const def = plat.cleanDefs()[id];
  if (!def) return new Promise((resolve, reject) => plat.special[id](mode, (err, r) => (err ? reject(err) : resolve(r))));
  const r = { id, bytes: 0, count: 0, freed: 0, removed: 0 };
  await walk(def.paths, def.days, async (p, size) => {
    r.bytes += size; r.count++;
    if (mode !== 'clean') return;
    try { await fsp.unlink(p); r.freed += size; r.removed++; } catch { /* kullanımda / kilitli: atla */ }
  });
  return r;
}

const ids = (plat) => [...Object.keys(plat.cleanDefs()), ...Object.keys(plat.special)];

function run(plat, mode, targets) {
  const job = chain.then(async () => {
    const out = [];
    for (const id of targets) out.push(await one(plat, mode, id));
    return out;
  });
  chain = job.catch(() => {});
  return job;
}

module.exports = { run, ids };
