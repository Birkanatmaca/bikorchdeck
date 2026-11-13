// Bikorch Deck: komik "iş bitti" seslerini üretir (macOS: `say` + Türkçe ses Yelda, ffmpeg).
// Çıktı public/sounds/<ad>.m4a dosyalarıdır ve depoya eklenir; Windows'ta da aynı dosyalar çalar, yeniden üretmek gerekmez.
//   node scripts/make-sounds.js           -> eksik olanları üret
//   node scripts/make-sounds.js --all     -> hepsini yeniden üret
// Gerçek ses kaynakları (Mixkit, Wikimedia Commons) ilk çalıştırmada data/sounds-src içine indirilir.
// Kaynaklar ve lisansları: public/sounds/KAYNAKLAR.md
// Yelda için: [[rate N]] konuşma hızı, [[pbas N]] ses inceliği, [[pmod N]] perde oynaklığı.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'sounds');
const SRC = path.join(ROOT, 'data', 'sounds-src');
const MIX = (id) => `https://assets.mixkit.co/active_storage/sfx/${id}/${id}-preview.mp3`;
const COMMONS = (name) => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(name);

// İndirilecek gerçek sesler: ad -> adres
const WEB = {
  stadyum: MIX(462), // Huge crowd cheering victory
  tribun: MIX(363), // Stadium chaotic loud applause, drums and chants
  dusme: MIX(391), // Falling male scream
  esek: MIX(1770), // Donkey scream
  palyaco: MIX(715), // Clown horn at circus
  parti: MIX(530), // Happy party horn sound
  fanfar: MIX(722), // Successful horns fanfare
  trombon: MIX(471), // Sad game over trombone
  kahkaha: MIX(424), // Crowd laugh
  jackpot: MIX(1996), // Slot machine payout alarm
  wilhelm: COMMONS('Wilhelm Scream.ogg'), // CC0
  horoz: COMMONS('Small rooster crowing.ogg'), // kamu malı
  kedi: COMMONS('Meow of a Siamese cat - freemaster2.wav'), // CC0
  davul: COMMONS('Drum Roll Intro.ogg'), // CC0
};

// Yalnızca konuşma: ad -> [ses, metin]
const SPEECH = {
  kanka: ['Yelda', '[[rate 210]] Kanka! İş bitti! Kalk bir bak!'],
  patron: ['Yelda', '[[rate 165]] [[pbas 38]] Patron. Emrettiğiniz iş, tamamlanmıştır efendim.'],
  anne: ['Yelda', '[[rate 190]] [[pbas 62]] Yemek hazıııır! Yani... iş hazır. Gel artık!'],
  kahve: ['Yelda', '[[rate 175]] İş bitti. Bir kahveyi hak ettin.'],
  opera: ['Good News', 'Bitti bitti bitti bitti'],
  robot: ['Zarvox', 'Gorev tamamlandi. Bip bop. Bitti.'],
  fisilti: ['Whisper', 'Psssst. Is bitti.'],
  // Nöbet modu (alarm sesleri seçme listesinde görünmez)
  nobet: ['Yelda', '[[rate 205]] [[pbas 40]] Hey! Sen kimsin? Bu masa sana ait değil! Fotoğrafın çekildi, bilgisayar kilitlendi.'],
  sifre: ['Yelda', '[[rate 200]] Seni tanıyamadım. Şifreni gir.'],
  hosgeldin: ['Yelda', '[[rate 210]] [[pbas 60]] Hoş geldin kanka!'],
};

// Karışımlar: ad -> parçalar [kaynak, başlangıç sn, en fazla süre, ses düzeyi çarpanı].
// Kaynak "web:<ad>" ya da "say:<ses>|<metin>". Hepsi aynı anda başlar; "@sn" ile gecikme verilir.
const MIXES = {
  gol: [['web:stadyum', 0, 5.5, 1.6], ['say:Yelda|[[rate 250]] [[pbas 72]] [[pmod 85]] Ve gooooooool! İş bittiii!', 0, 4, 1.4, 0.6]],
  tribun: [['web:tribun', 2, 5, 1.4]],
  cigl: [['web:dusme', 0, 2.2, 1], ['say:Yelda|[[rate 280]] [[pbas 95]] [[pmod 90]] Bittiiiiiiii!', 0, 2, 1.3, 1.6]],
  wilhelm: [['web:wilhelm', 0, 2, 1.2]],
  esek: [['web:esek', 0, 4, 1.2]],
  palyaco: [['web:palyaco', 0, 3, 1.2]],
  parti: [['web:parti', 0, 3, 1.2]],
  zafer: [['web:fanfar', 0, 4, 1.2]],
  kahkaha: [['web:kahkaha', 0, 4, 1.3]],
  jackpot: [['web:jackpot', 0, 4, 1]],
  horoz: [['web:horoz', 0, 3.6, 1], ['say:Yelda|[[rate 220]] Uyan! İş bitti!', 0, 2, 1.4, 3.2]],
  kedi: [['web:kedi', 0, 1.6, 1], ['web:kedi', 0, 1.6, 1, 1.1]],
  davul: [['web:davul', 0, 4, 1.6], ['say:Yelda|[[rate 200]] [[pbas 70]] Bitti!', 0, 1.5, 1.5, 3.7]],
  hata: [['web:trombon', 0, 4, 1.2]], // iş hatayla bitince (komik seslerde)
};

if (process.platform !== 'darwin') { console.error('Sesler yalnızca macOS’ta üretilebilir (say + ffmpeg). Hazır dosyalar public/sounds içinde.'); process.exit(1); }
const all = process.argv.includes('--all');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SRC, { recursive: true });

function get(url, file, hops = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BikorchDeck/1.0 (sound pack)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops) {
        res.resume(); resolve(get(new URL(res.headers.location, url).href, file, hops - 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(); });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '44100', '-movflags', '+faststart'];

async function main() {
  for (const [name, url] of Object.entries(WEB)) {
    const file = path.join(SRC, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) continue;
    for (let i = 0; ; i++) {
      try { await get(url, file); console.log('indirildi:', name); break; } catch (e) { if (i >= 3) throw e; await sleep(4000 * (i + 1)); }
    }
    await sleep(1500); // Commons hız sınırı
  }
  for (const [name, [voice, text]] of Object.entries(SPEECH)) {
    const file = path.join(OUT, name + '.m4a');
    if (!all && fs.existsSync(file)) continue;
    const tmp = path.join(SRC, `_${name}.aiff`);
    execFileSync('say', ['-v', voice, '-o', tmp, text]);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-af', 'loudnorm=I=-16:TP=-1.5', ...enc, file]);
    console.log('üretildi:', name);
  }
  for (const [name, parts] of Object.entries(MIXES)) {
    const file = path.join(OUT, name + '.m4a');
    if (!all && fs.existsSync(file)) continue;
    const args = ['-y', '-v', 'error'], filters = [];
    parts.forEach(([src, from, len, gain, delay = 0], i) => {
      let input = src.slice(4);
      if (src.startsWith('say:')) {
        const [voice, text] = input.split('|');
        input = path.join(SRC, `_${name}_${i}.aiff`);
        execFileSync('say', ['-v', voice, '-o', input, text]);
      } else input = path.join(SRC, input);
      args.push('-ss', String(from), '-t', String(len), '-i', input);
      // Her parça: tek kanal, sona doğru kısılır, gecikmesi uygulanır.
      filters.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,volume=${gain},afade=t=out:st=${Math.max(0, len - 0.5)}:d=0.5,adelay=${Math.round(delay * 1000)}[p${i}]`);
    });
    const mix = parts.length > 1 ? `${parts.map((_, i) => `[p${i}]`).join('')}amix=inputs=${parts.length}:duration=longest:normalize=0,` : `[p0]`;
    filters.push(`${mix}${parts.length > 1 ? '' : 'anull,'}loudnorm=I=-15:TP=-1[out]`.replace('[p0]anull,', '[p0]anull,'));
    execFileSync('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[out]', ...enc, file]);
    console.log('karıştırıldı:', name);
  }
  for (const f of fs.readdirSync(SRC)) if (f.startsWith('_')) fs.unlinkSync(path.join(SRC, f));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
