const fs = require('fs');
const path = require('path');

// Tarayıcı profil klasörlerini açar: base/<profil>/<sub> yollarından var olanları döndürür.
function profiles(base, subs) {
  let dirs;
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  return dirs.flatMap((d) => subs.map((s) => path.join(base, d.name, s))).filter((p) => fs.existsSync(p));
}

module.exports = { profiles };
