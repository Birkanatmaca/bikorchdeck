// Nöbet modu: tablet ön kamerayla masaya bakar, sahibini (kayıtlı yüz) tanır. Tanımadığı biri gelirse tablet
// fotoğrafını buraya gönderir; ajan fotoğrafı saklar ve bilgisayarı kilitler. Yüz tanıma tablette yapılır
// (face-api.js); burada yalnızca yüzün sayısal özeti (128 sayı), şifrenin özeti ve fotoğraflar durur.
// Her şey data/guard içindedir, hiçbir yere gönderilmez.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'guard');
const SHOTS = path.join(DIR, 'intruders');
const FILE = path.join(DIR, 'guard.json');
const MAX_FACES = 40; // kayıtlı yüz örneği (ilk kayıt + "beni öğren" ile eklenenler)

const fresh = () => ({ armed: false, lockPc: true, warnSec: 6, pausedUntil: 0, faces: [], pin: null });
let st = load();
function load() {
  try { return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return fresh(); }
}
function save() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(st));
  fs.renameSync(FILE + '.tmp', FILE);
}

// Şifre: PBKDF2 özeti saklanır. Üst üste 5 yanlışta 60 sn bekletilir (tahminle bulunmasın).
const hash = (pin, salt) => crypto.pbkdf2Sync(String(pin), salt, 120000, 32, 'sha256').toString('hex');
const okPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);
let wrong = 0, lockedUntil = 0;
function checkPin(pin) {
  if (!st.pin) return { ok: false, why: 'nopin' };
  if (Date.now() < lockedUntil) return { ok: false, why: 'wait', wait: Math.ceil((lockedUntil - Date.now()) / 1000) };
  const good = okPin(pin) && crypto.timingSafeEqual(Buffer.from(hash(pin, st.pin.salt), 'hex'), Buffer.from(st.pin.hash, 'hex'));
  if (good) { wrong = 0; return { ok: true }; }
  if (++wrong >= 5) { wrong = 0; lockedUntil = Date.now() + 60e3; }
  return { ok: false, why: 'wrong' };
}

const okFace = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10);

function shots() {
  let list = [];
  try { list = fs.readdirSync(SHOTS).filter((f) => /^\d+-[a-z]+\.jpg$/.test(f)); } catch { /* henüz yok */ }
  return list.sort().reverse().slice(0, 60).map((f) => ({ file: f, at: +f.split('-')[0], kind: f.split('-')[1].replace('.jpg', '') }));
}

const info = () => ({
  armed: st.armed, lockPc: st.lockPc, warnSec: st.warnSec, pausedUntil: st.pausedUntil > Date.now() ? st.pausedUntil : 0,
  hasPin: !!st.pin, faceCount: st.faces.length, faces: st.faces, shots: shots(),
});

// İstek: { op, pin?, ... }. Ayar değiştiren her işlem (kurulumdan sonra) şifre ister.
function op(o, plat) {
  if (!o || typeof o.op !== 'string') return null;
  const need = () => { const r = checkPin(o.pin); if (!r.ok) throw Object.assign(new Error(r.why), { r }); };
  try {
    switch (o.op) {
      case 'setpin': // ilk kurulum şifresiz; değiştirmek için eski şifre
        if (!okPin(o.newPin)) return { ok: false, why: 'format' };
        if (st.pin) need();
        { const salt = crypto.randomBytes(16).toString('hex'); st.pin = { salt, hash: hash(o.newPin, salt) }; }
        break;
      case 'faces': // yüz kaydı: önceki kayıt silinir
        if (!Array.isArray(o.faces) || !o.faces.length || o.faces.length > MAX_FACES || !o.faces.every(okFace)) return { ok: false, why: 'format' };
        if (st.pin) need();
        st.faces = o.faces.map((d) => d.map((x) => Math.round(x * 1e5) / 1e5));
        break;
      case 'learn': // şifreyle girildi, o anki yüz de sahibine eklenir (ilk kayıt korunur, en eski öğrenilen düşer)
        if (!okFace(o.face)) return { ok: false, why: 'format' };
        need();
        st.faces.push(o.face.map((x) => Math.round(x * 1e5) / 1e5));
        st.learned = (st.learned || 0) + 1;
        if (st.faces.length > MAX_FACES) st.faces.splice(st.firstCount || 10, 1);
        break;
      case 'arm': // açmak serbest (yüz ve şifre kayıtlıysa); kapatmak şifreli
        if (o.on) { if (!st.pin || !st.faces.length) return { ok: false, why: 'setup' }; st.armed = true; st.pausedUntil = 0; } else { need(); st.armed = false; }
        break;
      case 'unlock': { // şifre doğru: nöbet "mins" dakika susar
        need();
        const mins = [0, 2, 15, 30, 60, 120].includes(o.mins) ? o.mins : 15;
        st.pausedUntil = mins ? Date.now() + mins * 60e3 : 0;
        break;
      }
      case 'resume': st.pausedUntil = 0; break;
      case 'check': need(); return { ok: true, ...info() }; // yalnızca şifre denetimi (ayarlar ekranını açmak için)
      case 'settings':
        need();
        if (typeof o.lockPc === 'boolean') st.lockPc = o.lockPc;
        if ([3, 6, 10, 15].includes(o.warnSec)) st.warnSec = o.warnSec;
        break;
      case 'delshot': { // tek fotoğraf
        need();
        const f = typeof o.file === 'string' && shot(o.file);
        if (!f) return { ok: false, why: 'format' };
        fs.rmSync(f, { force: true });
        break;
      }
      case 'clearshots':
        need();
        for (const s of shots()) fs.rmSync(path.join(SHOTS, s.file), { force: true });
        break;
      default: return null;
    }
  } catch (e) {
    if (e.r) return { ok: false, ...e.r };
    throw e;
  }
  if (o.op === 'faces') st.firstCount = st.faces.length;
  save();
  return { ok: true, ...info() };
}

// Tablet tanımadığı birini gördü: { kind: 'uyari' | 'alarm', jpg: base64 }. Alarmda bilgisayar kilitlenir.
function alert(o, plat) {
  if (!o || !['uyari', 'alarm'].includes(o.kind)) return null;
  let file = null;
  if (typeof o.jpg === 'string' && o.jpg.length < 4e6) {
    const buf = Buffer.from(o.jpg.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      fs.mkdirSync(SHOTS, { recursive: true });
      file = `${Date.now()}-${o.kind}.jpg`;
      fs.writeFileSync(path.join(SHOTS, file), buf);
    }
  }
  let locked = false;
  if (o.kind === 'alarm' && st.armed && st.lockPc && plat.lock) { plat.lock(); locked = true; }
  console.log(`[nöbet] ${new Date().toLocaleString('tr-TR')} ${o.kind === 'alarm' ? 'ALARM' : 'uyarı'}: tanınmayan yüz${file ? ', fotoğraf ' + file : ''}${locked ? ', bilgisayar kilitlendi' : ''}`);
  return { ok: true, file, locked };
}

function shot(name) {
  if (!/^\d+-[a-z]+\.jpg$/.test(name)) return null;
  const p = path.join(SHOTS, name);
  return fs.existsSync(p) ? p : null;
}

module.exports = { info, op, alert, shot };
