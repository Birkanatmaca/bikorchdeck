// Claude limit halkası için tek seferlik kurulum: Claude Code ayarına (~/.claude/settings.json)
// durum satırı betiğini (scripts/statusline.js) ekler. Önce ayar dosyasının yedeğini alır.
// Geri almak: `npm run limit-kaldir` (yalnızca kendi eklediği satırı siler).
const fs = require('fs');
const path = require('path');
const os = require('os');

const file = path.join(os.homedir(), '.claude', 'settings.json');
const script = path.join(__dirname, 'statusline.js');
const command = `node "${script}"`;
const remove = process.argv.includes('--remove');

let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') { console.error('Ayar dosyası okunamadı, dokunulmadı:', e.message); process.exit(1); }
}
const ours = s.statusLine && String(s.statusLine.command || '').includes('statusline.js') && String(s.statusLine.command).includes(path.dirname(__dirname));

if (remove) {
  if (!ours) { console.log('Bikorch Deck durum satırı kurulu değil; değişiklik yapılmadı.'); process.exit(0); }
  delete s.statusLine;
} else {
  if (ours) { console.log('Zaten kurulu. Yeni bir Claude oturumunda mesaj yazınca halka dolar.'); process.exit(0); }
  if (s.statusLine) { console.error('Başka bir durum satırı zaten tanımlı; üzerine yazılmadı:', JSON.stringify(s.statusLine)); process.exit(1); }
  s.statusLine = { type: 'command', command };
}
if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bikorch-deck-yedek');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
console.log(remove ? 'Durum satırı kaldırıldı.' : 'Kuruldu. Yeni bir Claude oturumu aç ve bir mesaj yaz; halka birkaç saniyede dolar.');
console.log('Ayar dosyası:', file);
