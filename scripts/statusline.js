// Claude Code durum satırı betiği: Claude her güncellemede oturum bilgisini (JSON) stdin'den verir.
// İçindeki limit yüzdelerini data/claude-limits.json dosyasına yazar; Bikorch Deck ajanı oradan okur.
// Kurulum: ~/.claude/settings.json -> "statusLine": { "type": "command", "command": "node <bu dosya>" }
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let o = {};
  try { o = JSON.parse(raw); } catch { /* boş ya da bozuk girdi */ }
  const rl = o.rate_limits || o.rateLimits || {};
  const win = (w) => {
    if (!w || typeof w !== 'object') return null;
    const used = [w.used_percentage, w.usedPercentage, w.used_percent, w.utilization].find((v) => typeof v === 'number');
    if (used === undefined) return null;
    const r = w.resets_at ?? w.resetsAt ?? null;
    const resetsAt = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : r ? Date.parse(r) || null : null;
    return { used, resetsAt };
  };
  const h5 = win(rl.five_hour || rl.fiveHour), d7 = win(rl.seven_day || rl.sevenDay);
  try {
    const file = path.join(__dirname, '..', 'data', 'claude-limits.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // keys: limit alanı gelmiyorsa nedenini anlamak için yalnızca alan adları saklanır (içerik değil).
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), h5, d7, keys: Object.keys(o), limitKeys: Object.keys(rl) }));
  } catch { /* yazılamazsa durum satırı yine de çalışsın */ }
  const pct = (w) => (w ? '%' + Math.round(w.used) : '?');
  process.stdout.write(h5 || d7 ? `5 saat ${pct(h5)} · hafta ${pct(d7)}` : 'Bikorch Deck');
});
