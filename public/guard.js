// Bikorch Deck: nöbet modu. Tabletin ön kamerası masaya bakar; yüz tanıma tablette yapılır (face-api.js, public/vendor).
// - Sahibi (kayıtlı yüz) görünüyorsa sessiz kalır; yanında başkası olsa da.
// - Tanımadığı bir yüz birkaç kare üst üste görünürse: fotoğraf çeker, "şifreni gir" uyarısı ve geri sayım başlar.
// - Süre dolarsa: kırmızı alarm, siren, ikinci fotoğraf ve bilgisayar kilitlenir.
// - Doğru şifre (ya da sahibinin yüzü) alarmı susturur; nöbet seçilen süre kadar bekler, istenirse o anki yüz öğrenilir.
// Ayarlar, yüz özeti, şifre özeti ve fotoğraflar bilgisayarda data/guard içinde durur (server/guard.js).
// app.js'teki yardımcıları kullanır: $, esc, ac, tone, playUrl, layout, ago.
(() => {
  const MATCH = 0.5; // yüz uzaklığı bunun altındaysa sahibi (face-api: aynı kişi genelde 0.3–0.45)
  const STRIKES = 2; // tanımadığı yüz kaç kare üst üste görünürse uyarı (tablette bir kare ~1,5–2 sn)
  const OWNER_GONE = 5000; // sahibi en az bu kadar süredir görünmüyorsa yabancı uyarısı verilir
  const TICK = 650;
  const cam = $('gCam');
  const G = {
    info: null, owner: [], ready: null, stream: null, timer: 0, busy: false,
    ownerAt: 0, strikes: 0, mode: '', faces: [], unknown: null, pin: '', entry: '', onPin: null,
    count: 0, countTimer: 0, siren: 0, sheet: false, enroll: null, test: false,
  };

  // --- sunucu ---
  const api = async (body) => {
    const r = await fetch('/api/guard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({ ok: false }));
  };
  function setInfo(i) {
    if (!i || i.faces === undefined) return;
    G.info = i;
    G.owner = i.faces.map((f) => Float32Array.from(f));
    drawBtn();
    want();
  }
  const refresh = async () => { try { setInfo(await (await fetch('/api/guard')).json()); } catch { /* ajan yok */ } };
  const paused = () => G.info && G.info.pausedUntil > Date.now();
  const armed = () => G.info && G.info.armed && !paused();

  // --- kamera + model ---
  function loadModels() {
    G.ready = G.ready || new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = 'vendor/face-api/face-api.js';
      s.onload = async () => {
        try {
          // WASM: tabletlerin GPU'su (ör. Mali) WebGL'de yarım hassasiyetle hesaplayıp yüz bulamayabiliyor; WASM her yerde doğru ve yeterince hızlı.
          try { faceapi.tf.setWasmPaths('vendor/face-api/wasm/'); if (!(await faceapi.tf.setBackend('wasm'))) throw 0; } catch { await faceapi.tf.setBackend('webgl'); }
          await faceapi.tf.ready();
          const m = 'vendor/face-api/model';
          await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(m), faceapi.nets.faceLandmark68TinyNet.loadFromUri(m), faceapi.nets.faceRecognitionNet.loadFromUri(m)]);
          ok();
        } catch (e) { G.ready = null; bad(e); }
      };
      s.onerror = () => { G.ready = null; bad(new Error('face-api yüklenemedi')); };
      document.head.appendChild(s);
    });
    return G.ready;
  }
  async function camOn() {
    if (G.stream) return;
    G.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
    cam.srcObject = G.stream;
    await cam.play().catch(() => {});
  }
  function camOff() {
    if (!G.stream) return;
    G.stream.getTracks().forEach((t) => t.stop());
    G.stream = null; cam.srcObject = null;
  }
  // Kamera yalnızca nöbet açıkken (susturulmuş olsa da sahibini tanıyabilsin diye değil: susturulunca kapanır) ya da ayarlar açıkken çalışır.
  function want() {
    const need = armed() || G.sheet || G.mode === 'warn' || G.mode === 'alarm';
    if (need && !G.timer) start();
    if (!need && G.timer) { clearTimeout(G.timer); G.timer = 0; camOff(); camMsg('Kamera kapalı'); }
  }
  async function start() {
    G.timer = -1;
    camMsg('Kamera açılıyor…');
    try { await Promise.all([camOn(), loadModels()]); } catch (e) {
      G.timer = 0; camMsg('Kamera açılamadı: ' + (e.message || e.name) + '. Tablet uygulaması güncel mi?'); drawBtn(true); return;
    }
    camMsg('');
    loop();
  }
  async function loop() {
    if (!G.timer) return;
    if (!G.busy && cam.readyState >= 2) {
      G.busy = true;
      const t0 = performance.now();
      try { await tick(); G.err = ''; } catch (e) { G.err = String(e && e.message || e); console.warn('nöbet', e); }
      G.ms = Math.round(performance.now() - t0);
      if (G.sheet) status();
      G.busy = false;
    }
    if (G.timer) G.timer = setTimeout(loop, TICK);
  }
  const OPTS = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  // Kare önce 640 piksellik bir tuvale çizilir: Android WebView'da video doğrudan WebGL'e verilince siyah gelebiliyor;
  // küçük kare tanımayı da hızlandırır. Kutular gerçek görüntü ölçüsüne geri çevrilir.
  const frame = document.createElement('canvas');
  async function scan() {
    const k = Math.min(1, 640 / cam.videoWidth);
    frame.width = Math.round(cam.videoWidth * k); frame.height = Math.round(cam.videoHeight * k);
    frame.getContext('2d').drawImage(cam, 0, 0, frame.width, frame.height);
    const res = await faceapi.detectAllFaces(frame, OPTS()).withFaceLandmarks(true).withFaceDescriptors();
    return res.map((r) => {
      const b = r.detection.box;
      r.box = { x: b.x / k, y: b.y / k, width: b.width / k, height: b.height / k };
      let dist = 9;
      for (const o of G.owner) dist = Math.min(dist, faceapi.euclideanDistance(r.descriptor, o));
      return { box: r.box, desc: r.descriptor, dist, owner: dist < MATCH };
    });
  }

  async function tick() {
    const faces = await scan();
    G.faces = faces;
    if (G.sheet) drawBoxes(faces);
    if (G.enroll) { enrollStep(faces); return; }
    const now = Date.now();
    if (faces.some((f) => f.owner)) {
      G.ownerAt = now; G.strikes = 0;
      if ((G.mode === 'warn' || G.mode === 'alarm') && !G.test) welcome(); // denemede yalnızca şifre susturur
      return;
    }
    if (G.sheet || !armed() && !G.mode) return;
    if (faces.length) {
      // En büyük (en yakın) tanınmayan yüz: "bu bendim, öğren" için saklanır.
      G.unknown = faces.reduce((a, b) => (b.box.width > a.box.width ? b : a)).desc;
      if (now - G.ownerAt > OWNER_GONE && ++G.strikes >= STRIKES && !G.mode) warn();
    } else G.strikes = Math.max(0, G.strikes - 1);
  }

  // --- fotoğraf ---
  function snap() {
    const w = cam.videoWidth, h = cam.videoHeight;
    if (!w) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(cam, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.85);
  }
  async function report(kind) {
    if (G.test) return;
    try {
      await fetch('/api/guard/alert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, jpg: snap() }) });
    } catch { /* ajan yoksa fotoğraf kaybolur ama alarm sürer */ }
  }

  // --- sesler ---
  const vol = () => Math.max(layout.vol || 0, 6) / 10;
  const say = (name) => playUrl(`sounds/${name}.m4a`, Math.min(1, vol() * 1.3)).catch(() => {});
  function sirenOn() {
    sirenOff();
    const t0 = Date.now();
    const wail = () => {
      if (Date.now() - t0 > 45000) { sirenOff(); return; } // 45 sn sonra susar, ekran kırmızı kalır
      const v = 0.09 * vol();
      tone('sawtooth', 620, 1500, 0, 0.55, v); tone('sawtooth', 1500, 620, 0.55, 0.55, v);
      tone('square', 310, 750, 0, 0.55, v * 0.4); tone('square', 750, 310, 0.55, 0.55, v * 0.4);
    };
    // önce konuşma ("Sen kimsin? ..."), sonra siren
    G.siren = setTimeout(() => { if (G.siren) { wail(); G.siren = setInterval(wail, 1150); } }, 5200);
  }
  function sirenOff() { clearInterval(G.siren); clearTimeout(G.siren); G.siren = 0; }

  // --- uyarı -> alarm ---
  function warn(test) {
    G.test = !!test;
    G.mode = 'warn';
    G.count = (G.info && G.info.warnSec) || 6;
    report('uyari');
    say('sifre');
    over('warn', 'eye', 'SENİ TANIYAMADIM', 'Masa sahibi değilsen uzaklaş. Sahibiysen şifreni gir.');
    pinPad(unlockWith);
    $('gCount').textContent = G.count;
    clearInterval(G.countTimer);
    G.countTimer = setInterval(() => {
      if (--G.count <= 0) { clearInterval(G.countTimer); alarm(); } else $('gCount').textContent = G.count;
    }, 1000);
  }
  function alarm() {
    G.mode = 'alarm';
    $('gCount').textContent = '';
    report('alarm');
    say('nobet');
    sirenOn();
    over('alarm', 'alarm', 'TANINMAYAN YÜZ', `Fotoğrafın çekildi.${G.info && G.info.lockPc && !G.test ? ' Bilgisayar kilitlendi.' : ''} Susturmak için şifre.`);
    pinPad(unlockWith);
    want();
  }
  function stopAlert() {
    clearInterval(G.countTimer); sirenOff();
    G.mode = ''; G.strikes = 0; G.test = false;
  }
  // Sahibinin yüzü göründü: uyarı/alarm kendiliğinden kapanır.
  function welcome() {
    stopAlert();
    say('hosgeldin');
    over('ok', 'wave', 'HOŞ GELDİN', 'Seni tanıdım, alarm kapandı.');
    showPin(false);
    setTimeout(() => { if (G.mode === '') hideOver(); }, 2200);
  }

  // Şifre doğruysa: susturma süresi seçilir; tanınmadıysa o anki yüzü öğrenme seçeneği.
  async function unlockWith(pin) {
    const r = await api({ op: 'check', pin });
    if (!r.ok) return r;
    const learnable = !!G.unknown && !G.test;
    const wasTest = G.test;
    stopAlert();
    G.mode = 'ok';
    over('ok', 'check', 'ŞİFRE DOĞRU', 'Nöbet ne kadar sussun?');
    showPin(false);
    const a = $('gAfter');
    a.hidden = false;
    a.innerHTML = `<div class="row">${[[2, '2 DK'], [15, '15 DK'], [30, '30 DK'], [60, '1 SAAT'], [120, '2 SAAT']]
      .map(([m, t]) => `<button class="hbtn${m === 15 ? ' go' : ''}" data-m="${m}">${t}</button>`).join('')}<button class="hbtn" data-m="off">NÖBETİ KAPAT</button></div>`
      + (learnable ? '<button class="hbtn learn" data-learn="1">🧠 BU BENDİM, YÜZÜMÜ ÖĞREN</button>' : '');
    let learned = false, done = false;
    const finish = async (m) => {
      if (done) return; done = true;
      clearTimeout(auto);
      if (!wasTest) setInfo(m === 'off' ? await api({ op: 'arm', on: false, pin }) : await api({ op: 'unlock', pin, mins: m }));
      hideOver();
    };
    const auto = setTimeout(() => finish(15), 20000); // seçim yapılmazsa 15 dk
    a.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.learn && !learned) {
        learned = true; b.classList.add('done'); b.textContent = '🧠 ÖĞRENİLDİ';
        setInfo(await api({ op: 'learn', pin, face: Array.from(G.unknown) }));
        return;
      }
      if (b.dataset.m) finish(b.dataset.m === 'off' ? 'off' : +b.dataset.m);
    };
    return { ok: true };
  }

  // --- tam ekran: şifre / uyarı / alarm ---
  const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const ICON = {
    lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/><circle cx="12" cy="15.5" r="1.3" class="f"/>'),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>'),
    eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    alarm: svg('<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r=".9" class="f"/>'),
    check: svg('<circle cx="12" cy="12" r="9"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8"/>'),
    wave: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><circle cx="9" cy="10" r=".9" class="f"/><circle cx="15" cy="10" r=".9" class="f"/>'),
  };
  const KEY = { '⌫': svg('<path d="M9 5.5h10.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12z"/><path d="m11.5 9.5 5 5m0-5-5 5"/>'), '✓': svg('<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>') };
  const showPin = (on) => { $('gPin').hidden = !on; $('gDots').hidden = !on; };
  function over(cls, icon, title, text) {
    const o = $('gOver');
    o.className = 'gover ' + cls;
    $('gIcon').innerHTML = ICON[icon] || ''; $('gTitle').textContent = title; $('gText').textContent = text;
    $('gAfter').hidden = true; $('gAfter').innerHTML = '';
    showPin(true);
    $('gCancel').hidden = cls === 'warn' || cls === 'alarm' || cls === 'ok';
    if (cls !== 'warn') $('gCount').textContent = '';
    o.hidden = false;
  }
  function hideOver() { $('gOver').hidden = true; G.onPin = null; if (G.mode === 'ok') G.mode = ''; want(); }
  // Şifre tuş takımı. cb(pin) -> { ok } | { ok:false, why:'wrong'|'wait', wait }
  function pinPad(cb, len = 0) {
    G.entry = ''; G.onPin = cb; G.pinLen = len;
    $('gKeys').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, '✓'].map((k) => `<button data-k="${k}" class="${k === '✓' ? 'ok' : k === '⌫' ? 'del' : ''}">${KEY[k] || k}</button>`).join('');
    dots();
  }
  const dots = (bad) => {
    const n = Math.max(4, G.entry.length);
    $('gDots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < G.entry.length ? 'on' : ''}"></i>`).join('');
    $('gDots').classList.toggle('bad', !!bad);
  };
  $('gKeys').addEventListener('click', async (e) => {
    const k = e.target.closest('button') && e.target.closest('button').dataset.k;
    if (k === undefined || !G.onPin) return;
    if (k === '⌫') G.entry = G.entry.slice(0, -1);
    else if (k !== '✓') { if (G.entry.length < 8) G.entry += k; }
    dots();
    if (k !== '✓' && !(G.pinLen && G.entry.length === G.pinLen)) return;
    if (G.entry.length < 4) { dots(true); return; }
    const pin = G.entry, cb = G.onPin;
    G.entry = '';
    const r = await cb(pin);
    if (r && !r.ok) {
      dots(true);
      if (r.why === 'wait') $('gText').textContent = `Çok fazla yanlış deneme. ${r.wait} sn bekle.`;
      else if (G.mode === 'warn' && G.count > 2) { G.count = Math.min(G.count, 2); } // yanlış şifre: geri sayım hızlanır
    }
  });
  $('gCancel').addEventListener('click', hideOver);
  // Şifre sor; doğruysa then(pin). Şifre hiç yoksa doğrudan geçer.
  function askPin(title, text) {
    return new Promise((done) => {
      if (!G.info || !G.info.hasPin) { done(''); return; }
      over('', 'lock', title, text);
      pinPad(async (pin) => {
        const r = await api({ op: 'check', pin });
        if (r.ok) { hideOver(); setInfo(r); done(pin); }
        return r;
      });
    });
  }
  // Yeni şifre: iki kez girilir.
  function newPin(oldPin) {
    return new Promise((done) => {
      over('', 'key', 'YENİ ŞİFRE', '4–8 haneli bir şifre belirle.');
      pinPad(async (a) => {
        $('gTitle').textContent = 'TEKRAR GİR'; $('gText').textContent = 'Aynı şifreyi bir kez daha.';
        pinPad(async (b) => {
          if (a !== b) { newPinRetry(); return { ok: false }; }
          const r = await api({ op: 'setpin', pin: oldPin, newPin: b });
          if (r.ok) { setInfo(r); hideOver(); done(b); }
          return r;
        }, a.length);
        return { ok: true };
      });
      const newPinRetry = () => setTimeout(() => { hideOver(); newPin(oldPin).then(done); }, 500);
    });
  }

  // --- yüz kaydı ---
  const STEPS = [['Kameraya düz bak', 4], ['Başını hafifçe sağa çevir', 3], ['Şimdi hafifçe sola', 3], ['Biraz yukarı bak', 2]];
  function enroll() {
    G.enroll = { step: 0, got: [], need: STEPS.reduce((s, x) => s + x[1], 0), at: 0, msg: '' };
    $('gEnroll').hidden = false;
    enrollDraw();
    want();
  }
  function enrollDraw(extra) {
    const e = G.enroll, done = e.got.length;
    let n = 0, i = 0;
    for (; i < STEPS.length; i++) { n += STEPS[i][1]; if (done < n) break; }
    $('gEnrollMsg').textContent = extra || (STEPS[i] ? STEPS[i][0] : 'Tamam!');
    $('gEnrollBar').style.width = Math.round((done / e.need) * 100) + '%';
  }
  async function enrollStep(faces) {
    const e = G.enroll;
    if (faces.length !== 1) { enrollDraw(faces.length ? 'Kadrajda yalnızca sen ol' : 'Yüzünü göremiyorum, kameraya bak'); return; }
    if (faces[0].box.width < cam.videoWidth * 0.12) { enrollDraw('Biraz yaklaş'); return; }
    if (Date.now() - e.at < 450) return;
    e.at = Date.now();
    e.got.push(Array.from(faces[0].desc));
    enrollDraw();
    if (e.got.length < e.need) return;
    G.enroll = null;
    $('gEnrollMsg').textContent = 'Kaydediliyor…';
    const r = await api({ op: 'faces', pin: G.pin, faces: e.got });
    $('gEnroll').hidden = true;
    if (!r.ok) { $('gNote').textContent = 'Yüz kaydedilemedi'; return; }
    setInfo(r);
    if (!r.hasPin) G.pin = await newPin('');
    if (G.info.hasPin && G.info.faceCount && !G.info.armed) setInfo(await api({ op: 'arm', on: true }));
    drawSheet();
  }

  // --- ayarlar ekranı ---
  // Ayarlar ekranının altı: tanıma hızı ve varsa hata (tablette konsol görünmediği için).
  function status() {
    $('gNote').textContent = G.err ? 'Tanıma hatası: ' + G.err.slice(0, 120)
      : `Tanıma ${G.ms} ms · ${G.faces.length} yüz${G.faces.length && G.owner.length ? ' · ' + (G.faces.some((f) => f.owner) ? 'seni tanıyor' : 'tanımıyor') : ''} · ${faceapi.tf.getBackend()}`;
  }
  function camMsg(t) { $('gCamMsg').textContent = t; $('gCamMsg').hidden = !t; }
  function drawBoxes(faces) {
    if (!$('gView').contains(cam)) return;
    const cv = $('gBoxes'), w = cv.clientWidth, h = cv.clientHeight, vw = cam.videoWidth, vh = cam.videoHeight;
    if (!vw) return;
    cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio;
    const x = cv.getContext('2d');
    x.scale(devicePixelRatio, devicePixelRatio);
    // object-fit: cover + ayna: kutular görüntüyle aynı yere düşsün
    const s = Math.max(w / vw, h / vh), ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;
    x.lineWidth = 3; x.font = '600 14px system-ui';
    for (const f of faces) {
      const bx = w - (ox + (f.box.x + f.box.width) * s), by = oy + f.box.y * s, bw = f.box.width * s, bh = f.box.height * s;
      const c = f.owner ? '#3ccb7f' : '#f05d68';
      x.strokeStyle = c; x.strokeRect(bx, by, bw, bh);
      const label = G.owner.length ? (f.owner ? 'SEN' : 'TANIMIYORUM') + ` · ${(f.dist).toFixed(2)}` : 'YÜZ';
      x.fillStyle = c; x.fillRect(bx, by - 20, x.measureText(label).width + 10, 20);
      x.fillStyle = '#fff'; x.fillText(label, bx + 5, by - 5);
    }
  }
  function drawSheet() {
    const i = G.info || { armed: false, hasPin: false, faceCount: 0, shots: [] };
    const onoff = (v) => `<span class="val${v ? '' : ' off'}">${v ? 'AÇIK' : 'KAPALI'}</span>`;
    const row = (k, name, note, val, sel) => `<div class="crow${sel ? ' sel' : ''}" data-k="${k}"><span${sel !== undefined ? ' class="box"' : ''}></span><span>${name}<small>${note}</small></span>${val}</div>`;
    const ready = i.hasPin && i.faceCount;
    $('guardList').innerHTML =
      row('arm', 'Nöbet', ready ? (i.pausedUntil ? `Susturuldu: ${mins(i.pausedUntil - Date.now())} sonra kendiliğinden döner` : 'Tanımadığı biri gelirse uyarır') : 'Önce yüzünü tanıt ve şifre belirle', onoff(i.armed), i.armed)
      + (i.pausedUntil ? row('resume', 'Nöbete hemen dön', 'Susturmayı bitir', '<span class="val">▶</span>') : '')
      + row('face', 'Yüzüm', i.faceCount ? `${i.faceCount} örnek kayıtlı. Tanımazsa yeniden tanıt.` : 'Henüz kayıtlı değil', `<span class="val">${i.faceCount ? 'YENİDEN ›' : 'TANIT ›'}</span>`)
      + row('pin', 'Şifre', i.hasPin ? 'Seni tanımazsa bu şifreyle susturursun' : 'Henüz yok', `<span class="val">${i.hasPin ? 'DEĞİŞTİR ›' : 'BELİRLE ›'}</span>`)
      + row('lock', 'Bilgisayarı kilitle', 'Alarm çalınca ekran kilitlenir', onoff(i.lockPc), i.lockPc)
      + row('wait', 'Şifre süresi', 'Uyarıdan alarma kadar beklenen süre', `<span class="val">${i.warnSec} SN</span>`)
      + row('test', 'Alarmı dene', 'Fotoğraf çekmez, bilgisayarı kilitlemez', '<span class="val">▶ DENE</span>');
    $('gShots').innerHTML = i.shots.length ? i.shots.map((s) => `<div class="gshot ${s.kind}" data-f="${s.file}"><img loading="lazy" src="/guard/shot/${s.file}" alt=""><button class="gx" aria-label="Sil">×</button>${new Date(s.at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${s.kind === 'alarm' ? ' · ALARM' : ''}</div>`).join('')
      : '<span class="none">Henüz kimse gelmedi 🙂</span>';
    $('gClear').disabled = !i.shots.length;
    drawBtn();
  }
  async function openSheet() {
    await refresh();
    const pin = await askPin('ŞİFRE', 'Nöbet ayarları için şifreni gir.');
    G.pin = pin; G.sheet = true;
    $('gView').appendChild(cam); cam.play().catch(() => {}); // taşınan video durur
    $('guardSheet').hidden = false;
    $('gNote').textContent = 'Kutular: yeşil = sen, kırmızı = tanımadığı yüz. Sayı küçükse benzerlik yüksek.';
    drawSheet();
    want();
  }
  function closeSheet() {
    G.sheet = false; G.enroll = null; G.pin = '';
    $('gEnroll').hidden = true;
    document.body.appendChild(cam); cam.play().catch(() => {});
    $('guardSheet').hidden = true;
    want();
  }
  $('guardBtn').addEventListener('click', openSheet);
  $('guardClose').addEventListener('click', closeSheet);
  $('guardList').addEventListener('click', async (e) => {
    const r = e.target.closest('.crow');
    if (!r) return;
    const i = G.info, k = r.dataset.k;
    if (k === 'arm') {
      if (!i.hasPin || !i.faceCount) { $('gNote').textContent = 'Önce “Yüzüm” ile yüzünü tanıt; ardından şifre sorulur.'; return; }
      setInfo(await api({ op: 'arm', on: !i.armed, pin: G.pin }));
    }
    if (k === 'resume') setInfo(await api({ op: 'resume' }));
    if (k === 'face') { enroll(); return; }
    if (k === 'pin') { G.pin = await newPin(G.pin); await refresh(); }
    if (k === 'lock') setInfo(await api({ op: 'settings', pin: G.pin, lockPc: !i.lockPc }));
    if (k === 'wait') { const o = [3, 6, 10, 15]; setInfo(await api({ op: 'settings', pin: G.pin, warnSec: o[(o.indexOf(i.warnSec) + 1) % o.length] })); }
    if (k === 'test') {
      if (!i.hasPin) { $('gNote').textContent = 'Denemek için önce şifre belirle (alarmı şifreyle susturacaksın).'; return; }
      closeSheet(); warn(true); want(); return;
    }
    drawSheet();
  });
  // Fotoğraf görüntüleyici: küçük resme dokun -> büyük, ‹ › ile gez, SİL ile tek tek sil (iki dokunuş).
  let photo = -1, delArmed = 0;
  const shotList = () => (G.info && G.info.shots) || [];
  function showPhoto(i) {
    const list = shotList();
    if (!list.length) { $('gPhoto').hidden = true; photo = -1; return; }
    photo = Math.max(0, Math.min(list.length - 1, i));
    const s = list[photo];
    q($('gPhoto'), 'img').src = '/guard/shot/' + s.file;
    $('gpInfo').innerHTML = `<b class="${s.kind}">${s.kind === 'alarm' ? 'ALARM' : 'UYARI'}</b> ${new Date(s.at).toLocaleString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' })} <span class="dim">${photo + 1} / ${list.length}</span>`;
    $('gpPrev').hidden = photo === 0; $('gpNext').hidden = photo === list.length - 1;
    delArmed = 0; $('gpDel').textContent = 'SİL'; $('gpDel').classList.remove('arm');
    $('gPhoto').hidden = false;
  }
  async function delShot(file) {
    const r = await api({ op: 'delshot', pin: G.pin, file });
    if (r.ok) setInfo(r);
    drawSheet();
    return r.ok;
  }
  $('gShots').addEventListener('click', async (e) => {
    const x = e.target.closest('.gx');
    if (x) { // küçük resimdeki ×: ilk dokunuş "SİL?", ikincisi siler
      e.stopPropagation();
      if (!x.classList.contains('arm')) { x.classList.add('arm'); x.textContent = 'SİL?'; setTimeout(() => { x.classList.remove('arm'); x.textContent = '×'; }, 3000); return; }
      delShot(x.parentElement.dataset.f);
      return;
    }
    const b = e.target.closest('.gshot');
    if (b) showPhoto(shotList().findIndex((s) => s.file === b.dataset.f));
  });
  $('gpPrev').addEventListener('click', () => showPhoto(photo - 1));
  $('gpNext').addEventListener('click', () => showPhoto(photo + 1));
  $('gpClose').addEventListener('click', () => { $('gPhoto').hidden = true; });
  $('gpDel').addEventListener('click', async () => {
    if (Date.now() - delArmed > 3000) { delArmed = Date.now(); $('gpDel').textContent = 'EMİN MİSİN?'; $('gpDel').classList.add('arm'); return; }
    const s = shotList()[photo];
    if (s && await delShot(s.file)) showPhoto(photo);
  });
  let clearArmed = 0;
  $('gClear').addEventListener('click', async () => {
    if (Date.now() - clearArmed > 3000) { clearArmed = Date.now(); $('gClear').textContent = 'EMİN MİSİN?'; return; }
    $('gClear').textContent = 'FOTOĞRAFLARI SİL';
    setInfo(await api({ op: 'clearshots', pin: G.pin }));
    drawSheet();
  });

  // --- başlık düğmesi ---
  function drawBtn(err) {
    const b = $('guardBtn'), i = G.info;
    if (!b || !i) return;
    b.className = 'gbtn' + (err ? ' err' : i.armed ? (paused() ? ' paused' : ' on') : '');
    q(b, 'span').textContent = err ? 'KAMERA YOK' : !i.armed ? 'NÖBET' : paused() ? `SUSTU ${mins(i.pausedUntil - Date.now())}` : 'NÖBETTE';
  }
  // Susturma süresi dolunca nöbet kendiliğinden döner.
  setInterval(() => { drawBtn(); want(); }, 15000);
  refresh();
})();
