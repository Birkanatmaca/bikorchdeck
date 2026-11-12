// Bikorch Deck tablet arayüzü: /events akışını dinler, widget'ları çizer, dokunuşları PC'ye iletir.
// Ekran 24x16'lık bir ızgaradır; her widget {type, x, y, w, h, variant} ile yerleşir ve düzen PC'de saklanır.
const $ = (id) => document.getElementById(id);
const q = (el, s) => el.querySelector(s);
const COLS = 24, ROWS = 16, HIST = 120;
const grid = $('grid');
let hist = { cpu: [], mem: [], gpu: [], rx: [], tx: [] };
let last = null, lastAt = 0, layout = null, editing = false;
let profiles = [], activeProf = null; // kayıtlı ekran profilleri (bilgisayarda data/profiles.json)

// --- temalar ---
const THEMES = { bikorch: 'BIKORCH', terminal: 'TERMİNAL', amber: 'AMBER', buz: 'BUZ', neon: 'NEON', sade: 'SADE', acik: 'AÇIK' };
const C = {};
function applyTheme() {
  const t = THEMES[layout.theme] ? layout.theme : 'bikorch';
  document.documentElement.dataset.theme = t;
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['acc', 'acc2', 'ok', 'warn', 'bad', 'claude', 'line', 'dim', 'text', 'track']) C[k] = cs.getPropertyValue('--' + k).trim();
  $('themeBtn').textContent = 'TEMA: ' + THEMES[t];
}

// --- biçimlendirme ---
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (b / 2 ** 30).toFixed(1);
const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const rate = (b) => b >= 2 ** 20 ? (b / 2 ** 20).toFixed(1) + ' MB/s' : b >= 1024 ? (b / 1024).toFixed(0) + ' KB/s' : b + ' B/s';
const mb = (m) => m >= 1024 ? (m / 1024).toFixed(1) + ' GB' : m + ' MB';
const size = (b) => b >= 2 ** 30 ? (b / 2 ** 30).toFixed(2) + ' GB' : b >= 2 ** 20 ? (b / 2 ** 20).toFixed(0) + ' MB' : Math.round(b / 1024) + ' KB';
const heat = (v) => v >= 85 ? C.bad : v >= 60 ? C.warn : C.acc;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function dur(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `${d}g ${h}s` : `${h}s ${m}dk`;
}
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'şimdi' : s < 3600 ? Math.floor(s / 60) + ' dk' : s < 86400 ? Math.floor(s / 3600) + ' sa' : Math.floor(s / 86400) + ' g';
}
const model = (m) => String(m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const mins = (ms) => ms >= 3600e3 ? Math.floor(ms / 3600e3) + ' sa ' + Math.floor(ms / 60e3) % 60 + ' dk' : ms >= 60e3 ? Math.round(ms / 60e3) + ' dk' : Math.round(ms / 1000) + ' sn';
const ST = { calisiyor: 'ÇALIŞIYOR', tamam: 'TAMAM', bosta: 'boşta', hata: 'HATA' };
// Bikorch'un okuduğu hesap limitleri (Cursor, Claude, ...): kullanılan yüzde çubuğu.
const KIND = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' };
const limRow = (name, w) => `<div><span>${esc(name)}</span><u><i style="width:${clamp(w.used, 0, 100)}%;background:${heat(w.used)}"></i></u><span class="dim"><b>%${Math.round(w.used)}</b>${w.resetsAt > Date.now() ? ' · ' + mins(w.resetsAt - Date.now()) + ' sonra sıfırlanır' : ''}</span></div>`;
const limits = (s, only) => ((s.bikorch && s.bikorch.usage) || []).filter((u) => !only || u.kind === only)
  .filter((u) => !u.primary.resetsAt || u.primary.resetsAt > Date.now()).slice(0, 3) // sıfırlanma anı geçmiş kayıt artık geçersizdir
  .map((u) => limRow(`${KIND[u.kind] || u.kind} ${u.plan}`.trim(), u.primary) + (only && u.secondary ? limRow(u.secondary.label, u.secondary) : '')).join('');

// --- çizim ---
function prep(cv) {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  return { g, w, h, d };
}
function spark(cv, series, max) {
  const { g, w, h, d } = prep(cv);
  g.strokeStyle = C.line; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = Math.round((h * i) / 4) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const m = max || Math.max(1, ...series.flatMap((x) => x.data)) * 1.15;
  for (const s of series) {
    const data = s.data;
    if (data.length < 2) continue;
    const X = (i) => w - (data.length - 1 - i) * (w / (HIST - 1));
    const Y = (v) => h - 1.5 * d - (Math.min(v, m) / m) * (h - 3 * d);
    g.beginPath();
    data.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.strokeStyle = s.color; g.lineWidth = 1.6 * d; g.lineJoin = 'round'; g.stroke();
    g.lineTo(w, h); g.lineTo(X(0), h); g.closePath();
    g.globalAlpha = .13; g.fillStyle = s.color; g.fill(); g.globalAlpha = 1;
  }
}
function bars(cv, data, color) {
  const { g, w, h, d } = prep(cv);
  const m = Math.max(1, ...data), bw = w / data.length;
  data.forEach((v, i) => {
    const bh = v ? Math.max(2 * d, (v / m) * (h - 2 * d)) : 1 * d;
    g.fillStyle = v ? color : C.line;
    g.fillRect(i * bw + d, h - bh, bw - 2 * d, bh);
  });
}
function gauge(cv, pct, color) {
  const { g, w, h } = prep(cv);
  const r = Math.min(w / 2, h / 1.75) * .86, lw = r * .17, cx = w / 2, cy = h / 2 + r * .12;
  const a0 = Math.PI * .75, a1 = Math.PI * 2.25;
  g.lineCap = 'round'; g.lineWidth = lw;
  g.strokeStyle = C.track; g.beginPath(); g.arc(cx, cy, r - lw / 2, a0, a1); g.stroke();
  g.strokeStyle = color; g.beginPath(); g.arc(cx, cy, r - lw / 2, a0, a0 + (a1 - a0) * clamp(pct, 0.5, 100) / 100); g.stroke();
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(r * .52)}px ${getComputedStyle(document.body).fontFamily}`;
  g.fillText(Math.round(pct) + '%', cx, cy);
}

// Tam halka: ortada büyük yüzde, altında küçük etiket.
function ring(cv, pct, color, label) {
  const { g, w, h } = prep(cv);
  const r = Math.min(w, h) / 2 * .92, lw = r * .2, cx = w / 2, cy = h / 2, a0 = -Math.PI / 2;
  g.lineCap = 'round'; g.lineWidth = lw;
  g.strokeStyle = C.track; g.beginPath(); g.arc(cx, cy, r - lw / 2, 0, Math.PI * 2); g.stroke();
  if (pct != null) { g.strokeStyle = color; g.beginPath(); g.arc(cx, cy, r - lw / 2, a0, a0 + Math.PI * 2 * clamp(pct, 1, 100) / 100); g.stroke(); }
  const ff = getComputedStyle(document.body).fontFamily;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = pct == null ? C.dim : color; g.font = `700 ${Math.round(r * .5)}px ${ff}`;
  g.fillText(pct == null ? '—' : '%' + Math.round(pct), cx, cy - r * .08);
  g.fillStyle = C.dim; g.font = `600 ${Math.round(r * .19)}px ${ff}`;
  g.fillText(label, cx, cy + r * .34);
}
// Claude'da kalan pay. Kaynak sırası: Claude Code durum satırı (s.limits), yoksa Bikorch'un okuduğu hesap limiti.
// Veri yoksa halka boş kalır: tahmin gösterilmez.
const resetIn = (t) => t && t > Date.now() ? mins(t - Date.now()) + ' sonra sıfırlanır' : '5 saatlik limit';
const measured = (at) => Date.now() - at > 10 * 60e3 ? ` · ${ago(at)} önce ölçüldü` : '';
function claudeLimit(s) {
  const L = s.limits;
  if (L && L.h5 && !(L.h5.resetsAt && L.h5.resetsAt < Date.now())) return { left: 100 - L.h5.used, note: resetIn(L.h5.resetsAt) + measured(L.at), week: L.d7 ? 100 - L.d7.used : null };
  if (L && L.d7) return { left: 100 - L.d7.used, note: 'haftalık limit' + measured(L.at), week: null };
  const u = ((s.bikorch && s.bikorch.usage) || []).find((x) => x.kind === 'claude' && Date.now() - x.at < 6 * 3600e3);
  return u ? { left: 100 - u.primary.used, note: u.primary.reset || '5 saatlik limit', week: u.secondary ? 100 - u.secondary.used : null } : null;
}
function drawLimit(cv, s) {
  const l = claudeLimit(s);
  ring(cv, l ? l.left : null, !l ? C.dim : l.left < 15 ? C.bad : l.left < 40 ? C.warn : C.ok, l ? 'KALAN' : 'VERİ YOK');
  return l;
}

// --- yüzde gösteren widget'lar için ortak üç tasarım: grafik / gösterge / sayı ---
const METRIC = ['grafik', 'gosterge', 'sayi'];
const metricHTML = (v, extra) => v === 'gosterge' ? '<canvas class="gauge"></canvas><div class="sub ctr msub"></div>'
  : v === 'sayi' ? '<div class="huge"><span><span class="pct">0</span><small>%</small></span></div><div class="sub ctr msub"></div>'
  : `<div class="row"><div class="big"><span class="pct">0</span><small>%</small></div><canvas class="sp"></canvas></div>${extra}`;
function metricUpdate(el, v, pct, series, color, sub) {
  if (v === 'gosterge') gauge(q(el, '.gauge'), pct, heat(pct));
  else {
    const p = q(el, '.pct');
    p.textContent = Math.round(pct); p.style.color = heat(pct);
    if (v !== 'sayi') spark(q(el, '.sp'), [{ data: series, color }], 100);
  }
  const s = q(el, '.msub');
  if (s) s.textContent = sub;
}

// --- widget türleri ---
const W = {
  cpu: {
    title: 'CPU', note: 'İşlemci kullanımı ve çekirdekler', size: [5, 3], min: [2, 2], variants: METRIC,
    build: (v) => metricHTML(v, '<div class="cores"></div>'),
    update(el, s, v) {
      q(el, '.wsub').textContent = s.cores + ' çekirdek';
      metricUpdate(el, v, s.cpu.total, hist.cpu, C.acc, s.cpuModel);
      const cores = q(el, '.cores');
      if (!cores) return;
      if (cores.children.length !== s.cpu.cores.length) cores.innerHTML = s.cpu.cores.map(() => '<i></i>').join('');
      s.cpu.cores.forEach((x, i) => { const e = cores.children[i]; e.style.setProperty('--v', x + '%'); e.style.setProperty('--c', heat(x)); });
    },
  },
  mem: {
    title: 'BELLEK', note: 'RAM kullanımı', size: [4, 2], min: [2, 2], variants: METRIC,
    build: (v) => metricHTML(v, '<div class="sub msub"></div>'),
    update(el, s, v) {
      const txt = `${gb(s.mem.used)} / ${gb(s.mem.total)} GB` + (s.memTop[0] && v === 'grafik' ? ` · en çok: ${s.memTop[0].name} ${mb(s.memTop[0].mem)}` : '');
      metricUpdate(el, v, (s.mem.used / s.mem.total) * 100, hist.mem, C.acc2, txt);
    },
  },
  gpu: {
    title: 'GPU', note: 'Ekran kartı: kullanım, VRAM, ısı, güç', size: [3, 3], min: [2, 2], variants: METRIC,
    build: (v) => metricHTML(v, `<div class="kv"><div><span>VRAM</span><b class="gm">—</b></div><div><span>ISI</span><b class="gt">—</b></div><div><span>GÜÇ</span><b class="gp">—</b></div></div><div class="bar"><i class="gb"></i></div>`),
    update(el, s, v) {
      const g = s.gpu;
      q(el, '.wsub').textContent = g ? g.name.replace(/^NVIDIA\s+/i, '') : s.os === 'darwin' ? 'macOS’ta okunamıyor' : 'bulunamadı';
      if (!g) return;
      const vram = `${(g.memUsed / 1024).toFixed(1)}/${(g.memTotal / 1024).toFixed(0)} GB`;
      metricUpdate(el, v, g.util, hist.gpu, C.warn, `${vram} · ${g.temp}°C · ${Math.round(g.power)} W`);
      if (v !== 'grafik') return;
      q(el, '.gm').textContent = vram;
      q(el, '.gt').textContent = g.temp + '°C';
      q(el, '.gt').style.color = g.temp >= 80 ? C.bad : '';
      q(el, '.gp').textContent = Math.round(g.power) + ' W';
      q(el, '.gb').style.width = (g.memTotal ? (g.memUsed / g.memTotal) * 100 : 0) + '%';
    },
  },
  disk: {
    title: 'DİSK', note: 'Sürücülerin doluluğu', size: [4, 1], min: [2, 1],
    build: () => '<div class="bars"></div>',
    update(el, s) {
      q(el, '.bars').innerHTML = s.disks.map((d) => {
        const p = d.total ? ((d.total - d.free) / d.total) * 100 : 0;
        return `<div><span>${esc(d.name)}</span><u><i style="width:${p.toFixed(0)}%;background:${p > 90 ? C.bad : C.acc2}"></i></u><span class="dim">${gb(d.free)} GB boş</span></div>`;
      }).join('');
    },
  },
  net: {
    title: 'AĞ', note: 'İndirme ve yükleme hızı', size: [3, 2], min: [2, 2],
    build: () => `<div class="kv two"><div><span>↓ İNDİRME</span><b class="rx">—</b></div><div><span>↑ YÜKLEME</span><b class="tx">—</b></div></div><canvas class="sp"></canvas>
      <div class="nd"><div><span>GECİKME</span><b class="pg">—</b></div><div><span>BAĞLANTI</span><b class="nif">—</b></div>
      <div><span>YEREL IP</span><b class="nip">—</b></div><div><span>TOPLAM ↓ / ↑</span><b class="ntot">—</b></div></div>`,
    update(el, s) {
      const n = s.netx;
      q(el, '.wsub').innerHTML = n.online == null ? '' : `<span class="chip" style="border-color:${n.online ? C.ok : C.bad};color:${n.online ? C.ok : C.bad}">${n.online ? 'internet var' : 'internet yok'}</span>`;
      const pg = q(el, '.pg');
      pg.textContent = n.ping == null ? '—' : n.ping + ' ms';
      pg.style.color = n.ping == null ? C.bad : n.ping > 150 ? C.bad : n.ping > 60 ? C.warn : C.ok;
      q(el, '.nif').textContent = n.iface || 'yok';
      q(el, '.nip').textContent = n.ip || '—';
      q(el, '.ntot').textContent = `${size(n.totRx)} / ${size(n.totTx)}`;
      q(el, '.rx').textContent = rate(s.net.rx);
      q(el, '.tx').textContent = rate(s.net.tx);
      spark(q(el, '.sp'), [{ data: hist.rx, color: C.acc }, { data: hist.tx, color: C.acc2 }]);
    },
  },
  claude: {
    title: 'CLAUDE', note: 'Token kullanımı, saatlik grafik, oturumlar', size: [5, 5], min: [3, 2], variants: ['tam', 'ozet'],
    build: (v) => `<div class="lrow"><canvas class="ring"></canvas><div class="tiles">${['SON 5 SAAT', 'BUGÜN', '7 GÜN'].map((t) => `<div class="tile"><span>${t}</span><b>—</b><em></em></div>`).join('')}</div></div>
      <div class="sub lnote"></div>
      <div class="cap">ÇIKTI TOKEN / SAAT · SON 24 SAAT</div><canvas class="hc"></canvas><div class="models"></div>
      ${v === 'ozet' ? '' : '<div class="cap">OTURUMLAR</div><div class="list sess"></div>'}`,
    update(el, s) {
      const c = s.claude;
      if (!c) return;
      q(el, '.wsub').innerHTML = `<span class="chip${c.activeCount ? ' on' : ''}">${c.activeCount} aktif</span>`;
      [c.h5, c.today, c.d7].forEach((b, i) => {
        const t = el.querySelectorAll('.tile')[i];
        q(t, 'b').textContent = tok(b.out);
        q(t, 'em').textContent = `${b.n} yanıt · girdi ${tok(b.in + b.cw)}`;
      });
      const l = drawLimit(q(el, '.ring'), s);
      q(el, '.lnote').textContent = !l ? 'Kalan limit: son 24 saatte ölçüm yok' : 'Kalan limit: ' + l.note + (l.week != null ? ` · haftalık %${Math.round(l.week)} kaldı` : '');
      bars(q(el, '.hc'), c.hourly, C.claude);
      q(el, '.models').innerHTML = Object.entries(c.byModel).sort((a, b) => b[1].out - a[1].out)
        .map(([m, b]) => `<span>${esc(model(m))} <b>${tok(b.out)}</b></span>`).join('') || '<span class="dim">bugün kullanım yok</span>';
      const sess = q(el, '.sess');
      if (sess) sess.innerHTML = c.sessions.map((x) =>
        `<div class="item s-${x.status}"><span class="dot"></span><span class="t">${esc(x.title || x.project)} <span class="n">${esc(x.title ? x.project + ' · ' : '')}${esc(model(x.model))}</span></span><span class="r"><span class="st">${ST[x.status]}</span> · ${tok(x.out)} · ${ago(x.last)}</span></div>`).join('');
    },
  },
  bikorch: {
    title: 'BIKORCH', note: 'Aktif projeler, biten işler, hesap limitleri', size: [4, 5], min: [3, 2], variants: ['tam', 'projeler'],
    build: (v) => `<div class="list scroll prj"></div>${v === 'projeler' ? '' : '<div class="cap">SON BİTEN İŞLER</div><div class="list ntc"></div><div class="lims"></div>'}`,
    update(el, s, v) {
      const b = s.bikorch;
      if (!b) return;
      const busy = b.projects.filter((p) => p.status === 'calisiyor').length;
      q(el, '.wsub').innerHTML = `<span class="chip${b.running ? ' on' : ''}">${b.running ? 'uygulama açık' : b.installed ? 'uygulama kapalı' : 'kurulu değil'}</span><span class="chip">${busy} çalışıyor</span>`;
      q(el, '.prj').innerHTML = b.projects.map((p) =>
        `<div class="item s-${p.status}"><span class="dot"></span><span class="t">${esc(p.name)}${p.bikorch ? `<span class="tag">${p.current ? 'AKTİF' : 'BIKORCH'}</span>` : ''} <span class="n">${esc(p.title)}</span></span><span class="r"><span class="st">${ST[p.status]}</span>${p.last ? ' · ' + ago(p.last) : ''}</span></div>`).join('')
        || '<div class="sub">Henüz proje yok</div>';
      if (v === 'projeler') return;
      q(el, '.ntc').innerHTML = s.notices.slice(0, 3).map((n) =>
        `<div class="item s-${n.outcome === 'error' ? 'hata' : 'tamam'}"><span class="dot"></span><span class="t">${esc(n.project)} <span class="n">${esc(n.title)}</span></span><span class="r">${esc(n.src)}${n.ms ? ' · ' + mins(n.ms) : ''} · ${ago(n.t)}</span></div>`).join('')
        || '<div class="sub">Bir iş bitince burada ve ekranın üstünde görünür</div>';
      q(el, '.lims').innerHTML = limits(s) + (limits(s) ?`<div><span class="dim">Bikorch verisi</span><span></span><span class="dim">${ago(b.dbAt)} önce</span></div>` : '');
    },
  },
  music: {
    title: 'MÜZİK', note: 'Çalan şarkı, kapak resmi, ileri / geri', size: [2, 4], min: [2, 3],
    build: () => `<div class="mus"><img class="art" alt=""><div class="mi"><b class="mt">—</b><span class="ma"></span>
      <div class="mc"><button data-m="prev" aria-label="Önceki"><svg viewBox="0 0 24 24"><rect x="5" y="5.5" width="2.2" height="13" rx="1.1"/><path d="M18.5 6.5v11L10 12z"/></svg></button><button data-m="toggle" class="pp" aria-label="Duraklat / devam"><svg class="i-play" viewBox="0 0 24 24"><path d="M9 6.5v11l9-5.5z"/></svg><svg class="i-pause" viewBox="0 0 24 24"><rect x="6.5" y="5.5" width="3.6" height="13" rx="1.2"/><rect x="13.9" y="5.5" width="3.6" height="13" rx="1.2"/></svg></button><button data-m="next" aria-label="Sonraki"><svg viewBox="0 0 24 24"><path d="M5.5 6.5v11L14 12z"/><rect x="16.8" y="5.5" width="2.2" height="13" rx="1.1"/></svg></button></div></div></div>`,
    update(el, s) {
      const m = s.media, art = q(el, '.art');
      q(el, '.wsub').textContent = m ? m.app + (m.playing ? ' · çalıyor' : ' · duraklatıldı') : 'açık değil';
      q(el, '.mt').textContent = m ? m.title || '—' : 'Çalan bir şey yok';
      q(el, '.ma').textContent = m ? m.artist || '' : s.os === 'darwin' ? 'Spotify ya da Müzik açılınca görünür' : 'Spotify açılınca burada görünür';
      q(el, '.pp').classList.toggle('on', !!(m && m.playing));
      el.classList.toggle('off', !m);
      const src = m && m.art ? `/media/art?k=${m.art}-${encodeURIComponent(m.title)}` : '';
      if (art.dataset.src !== src) { art.dataset.src = src; if (src) art.src = src; else art.removeAttribute('src'); }
    },
  },
  ses: {
    title: 'SES', note: 'Bilgisayarın ses düzeyi: kaydır, azalt / artır, sessize al', size: [3, 2], min: [3, 1],
    build: () => `<div class="vol"><div class="vin"><div class="vtop"><button class="vm" data-v="mute" aria-label="Sessize al / aç">
      <svg class="i-on" viewBox="0 0 24 24"><path class="f" d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z"/><path d="M15.3 9.2a4 4 0 0 1 0 5.6M17.9 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>
      <svg class="i-off" viewBox="0 0 24 24"><path class="f" d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/></svg>
      </button><b class="vn">—</b></div>
      <div class="vrow"><button data-v="down" aria-label="Sesi azalt">−</button><input class="vs" type="range" min="0" max="100" step="1" aria-label="Ses düzeyi"><button data-v="up" aria-label="Sesi artır">+</button></div></div></div>`,
    update(el, s) {
      const a = volNow(s);
      el.classList.toggle('off', !a);
      q(el, '.wsub').textContent = a ? (a.mute ? 'sessizde' : '') : 'ses aygıtı okunamadı';
      q(el, '.vn').innerHTML = a ? `${a.vol}<small>%</small>` : '—';
      q(el, '.vm').classList.toggle('muted', !!a && (a.mute || a.vol === 0));
      const sl = q(el, '.vs');
      if (a) sl.value = a.vol;
      sl.style.setProperty('--p', (a ? a.vol : 0) + '%');
    },
  },
  limit: {
    title: 'CLAUDE LİMİT', note: 'Kalan pay, yuvarlak gösterge', size: [2, 2], min: [2, 2],
    build: () => '<canvas class="ring"></canvas><div class="sub ctr lnote"></div>',
    update(el, s) {
      const l = drawLimit(q(el, '.ring'), s);
      q(el, '.lnote').textContent = !l ? 'ölçüm yok' : l.note;
    },
  },
  // Tek alanda iki görünüm: üstteki anahtarla Bikorch <-> Claude arasında geçilir (seçim kaydedilir).
  ai: {
    title: 'ÇALIŞMA ALANI', note: 'Bikorch ve Claude tek alanda; anahtarla geçiş', size: [7, 8], min: [3, 3], variants: ['bikorch', 'claude'],
    build: (v) => `<div class="seg"><button data-sw="bikorch"${v === 'bikorch' ? ' class="on"' : ''}>BIKORCH</button><button data-sw="claude"${v === 'claude' ? ' class="on"' : ''}>CLAUDE</button></div>${W[v].build('tam')}`,
    update(el, s, v) { W[v].update(el, s, 'tam'); },
  },
  windows: {
    title: 'AÇIK PENCERELER', note: 'Dokununca bilgisayarda öne gelir', size: [4, 5], min: [2, 2],
    build: () => '<div class="list scroll wl"></div><div class="hint">Dokun → bilgisayarda öne getir</div>',
    update(el, s) {
      q(el, '.wsub').textContent = s.windows.length;
      q(el, '.wl').innerHTML = s.windows.slice().sort((a, b) => b.active - a.active || a.name.localeCompare(b.name))
        .map((w) => `<div class="item${w.active ? ' active' : ''}" data-hwnd="${w.hwnd}"><span class="n">${esc(w.name)}</span><span class="t">${esc(w.title)}</span><span></span></div>`).join('');
    },
  },
  procs: {
    title: 'SÜREÇLER', note: 'En çok işlemci kullanan programlar', size: [3, 3], min: [2, 2],
    build: () => '<div class="list pl"></div>',
    update(el, s) {
      q(el, '.wsub').textContent = "CPU'ya göre";
      q(el, '.pl').innerHTML = s.procs.map((p) =>
        `<div class="item"><span class="t">${esc(p.name)}${p.n > 1 ? ` <span class="n">×${p.n}</span>` : ''}</span><span></span><span class="r"><b style="color:${heat(p.cpu * 2)}">${p.cpu.toFixed(1)}%</b> · ${mb(p.mem)}</span></div>`).join('');
    },
  },
  memtop: {
    title: 'BELLEK SIRALAMASI', note: 'En çok RAM kullanan programlar', size: [3, 2], min: [2, 2],
    build: () => '<div class="list ml"></div>',
    update(el, s) {
      q(el, '.ml').innerHTML = s.memTop.map((p) =>
        `<div class="item"><span class="t">${esc(p.name)}${p.n > 1 ? ` <span class="n">×${p.n}</span>` : ''}</span><span></span><span class="r"><b>${mb(p.mem)}</b></span></div>`).join('');
    },
  },
  clock: {
    title: 'SAAT', note: 'Büyük saat ve tarih', size: [3, 2], min: [2, 1],
    build: () => '<div class="huge clk"></div><div class="sub ctr dt"></div>',
    update(el) {
      const d = new Date();
      q(el, '.clk').textContent = d.toLocaleTimeString('tr-TR');
      q(el, '.dt').textContent = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    },
  },
};

// Widget boyutları yukarıda eski 12x8 birimiyle yazılı; 24x16 ızgaraya çevrilir.
// En küçük boyut yarım adım daha küçülebilir (ince ayar).
for (const d of Object.values(W)) {
  d.size = d.size.map((n) => n * 2);
  d.min = [Math.max(3, d.min[0] * 2 - 1), Math.max(2, d.min[1] * 2 - 1)];
}
const double = (w) => ({ ...w, x: w.x * 2, y: w.y * 2, w: w.w * 2, h: w.h * 2 });
const PREFS = { sound: true, toast: true, dock: true, vol: 7, tone: 'cift' };
const DEFAULT = () => ({
  theme: 'bikorch', g: 24, ...PREFS,
  widgets: [
    { id: 'ai-1', type: 'ai', x: 0, y: 0, w: 10, h: 16 }, { id: 'music-1', type: 'music', x: 10, y: 7, w: 4, h: 9 },
    { id: 'cpu-1', type: 'cpu', x: 14, y: 0, w: 5, h: 5 }, { id: 'mem-1', type: 'mem', x: 19, y: 0, w: 5, h: 5 },
    { id: 'gpu-1', type: 'gpu', x: 14, y: 5, w: 5, h: 5 }, { id: 'net-1', type: 'net', x: 19, y: 5, w: 5, h: 5 },
    { id: 'procs-1', type: 'procs', x: 14, y: 10, w: 6, h: 6 }, { id: 'limit-1', type: 'limit', x: 10, y: 0, w: 4, h: 7 },
    { id: 'disk-1', type: 'disk', x: 20, y: 10, w: 4, h: 6 },
  ],
});

// --- bilgisayarın ses düzeyi ---
// Tabletten verilen değer, bilgisayar yeni durumu bildirene kadar (birkaç saniye) ekranda tutulur.
let volHold = null, volTimer = 0, volPending = null;
function volNow(s) {
  if (volHold && Date.now() < volHold.until) return volHold;
  volHold = null;
  return s && s.audio;
}
function volSend(body) {
  fetch('/api/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
function setVol(vol, mute) {
  const cur = volNow(last);
  if (!cur) return;
  volHold = { vol: vol == null ? cur.vol : Math.max(0, Math.min(100, Math.round(vol))), mute: mute == null ? cur.mute : mute, until: Date.now() + 3500 };
  // Kaydırırken saniyede en çok ~8 istek; düzey ve sessiz aynı istekte gider.
  volPending = volPending || {};
  if (vol != null) volPending.vol = volHold.vol;
  if (mute != null) volPending.mute = mute;
  if (!volTimer) volTimer = setTimeout(() => { volTimer = 0; volSend(volPending); volPending = null; }, 120);
  if (last) render(last);
}

// --- "iş tamam" bildirimi: ekranın üstünde yazı + kısa ses ---
let lastNotice = 0, toastTimer = 0, audio = null;
// Bitti sesleri: [frekanslar, notalar arası süre, her notanın uzunluğu]
const TONES = { cift: ['ÇİFT BİP', [660, 880], .16, .3], can: ['ÇAN', [1047, 1568], .09, 1.1], uclu: ['YÜKSELEN', [523, 659, 784], .13, .28], tek: ['TEK BİP', [880], 0, .25] };
function chime(err) {
  if (!layout.vol) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const [, notes, gap, len] = err ? ['', [392, 262], .18, .35] : TONES[layout.tone] || TONES.cift;
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * gap;
      o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.06 * layout.vol, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + len);
      o.start(t); o.stop(t + len + .02);
    });
  } catch { /* ses yoksa yalnızca yazı görünür */ }
}
function announce(list) {
  const fresh = list.filter((n) => n.id > lastNotice);
  if (!fresh.length) return;
  lastNotice = Math.max(...list.map((n) => n.id));
  const n = fresh[0], err = n.outcome === 'error', t = $('toast');
  if (layout.sound) chime(err);
  if (!layout.toast) return;
  t.className = err ? 'err' : '';
  t.innerHTML = `<b>${err ? '✕ HATA' : '✓ İŞ TAMAM'}</b>${esc(n.project)}${n.title ? ' — ' + esc(n.title) : ''} <span class="dim">${esc(n.src)}${n.ms ? ' · ' + mins(n.ms) : ''}</span>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 12000);
}
$('toast').addEventListener('click', () => { $('toast').hidden = true; });

// --- ızgara ---
const variantOf = (w) => { const vs = W[w.type].variants; return vs ? (vs.includes(w.variant) ? w.variant : vs[0]) : undefined; };
const place = (w) => { w.el.style.gridColumn = `${w.x + 1} / span ${w.w}`; w.el.style.gridRow = `${w.y + 1} / span ${w.h}`; };
const collides = (w) => layout.widgets.some((o) => o !== w && w.x < o.x + o.w && o.x < w.x + w.w && w.y < o.y + o.h && o.y < w.y + w.h);
const inside = (w) => w.w >= 1 && w.h >= 1 && w.x + w.w <= COLS && w.y + w.h <= ROWS;

function fillBody(w) {
  if (w.type === 'ai') w.el.className = 'p w-ai w-' + variantOf(w); // seçili görünümün stilleri geçerli olsun
  q(w.el, '.body').innerHTML = W[w.type].build(variantOf(w));
}
function buildAll() {
  grid.innerHTML = '';
  layout.widgets = layout.widgets.filter((w) => W[w.type] && inside(w));
  for (const w of layout.widgets) {
    const def = W[w.type];
    const el = document.createElement('section');
    el.className = 'p w-' + w.type;
    el.innerHTML = `<h2><span>${def.title}</span><span class="dim wsub"></span></h2><div class="body"></div>
      <div class="ed"><span class="en">${def.title}</span>${def.variants ? '<button class="eb s" data-act="var" aria-label="Tasarım değiştir">◐</button>' : ''}
      <button class="eb x" data-act="del" aria-label="Kaldır">✕</button><i class="rs" data-act="rs"></i></div>`;
    w.el = el;
    place(w); fillBody(w);
    grid.appendChild(el);
  }
  if (last) render(last);
}
function save() {
  const { theme, g, sound, toast, dock, vol, tone } = layout;
  const body = { theme, g, sound, toast, dock, vol, tone, widgets: layout.widgets.map(({ id, type, x, y, w, h, variant }) => ({ id, type, x, y, w, h, variant })) };
  fetch('/api/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
function setLayout(l) {
  layout = l && Array.isArray(l.widgets) && l.widgets.length ? l : DEFAULT();
  if (layout.g !== 24) { layout.widgets = layout.widgets.map(double); layout.g = 24; } // eski 12x8 düzeni çevir
  layout = { ...PREFS, ...layout };
  applyTheme(); buildAll();
}

// --- alt şerit (dock): açık pencereler ---
let dockSig = '';
function drawDock(s) {
  // Şerit kapatılsa da roket (temizlik) yerinde kalır.
  $('dockBar').hidden = $('dockSep').hidden = !layout.dock;
  if (!layout.dock) return;
  const wins = s.windows.slice().sort((a, b) => a.name.localeCompare(b.name) || a.hwnd - b.hwnd); // sıra sabit kalsın
  const sig = JSON.stringify(wins.map((w) => [w.hwnd, w.name, w.active]));
  if (sig === dockSig) return; // değişmediyse dokunma: kaydırma ve dokunuş bozulmasın
  dockSig = sig;
  $('dockBar').innerHTML = wins.map((w) => {
    let h = 0;
    for (const c of w.name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<button class="dk${w.active ? ' active' : ''}" data-hwnd="${w.hwnd}" style="--h:${h}" aria-label="${esc(w.name)}"><img src="/icon/${encodeURIComponent(w.name)}" alt="" data-l="${esc(w.name.slice(0, 1).toUpperCase())}"></button>`;
  }).join('');
  // Simgesi alınamayan uygulamada baş harf gösterilir.
  for (const img of $('dockBar').querySelectorAll('img')) {
    img.onerror = () => { const i = document.createElement('i'); i.textContent = img.dataset.l; img.replaceWith(i); };
  }
  const act = q($('dockBar'), '.active');
  if (act) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
async function focusWindow(it) {
  it.classList.add('busy');
  try {
    await fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hwnd: Number(it.dataset.hwnd) }) });
  } catch { /* bağlantı koptuysa üstteki gösterge zaten uyarır */ }
}
$('dockBar').addEventListener('click', (e) => { const it = e.target.closest('.dk'); if (it) focusWindow(it); });

function render(s) {
  $('host').textContent = s.host;
  $('uptime').textContent = dur(s.uptime);
  drawDock(s);
  const r = s.reclaim, rc = $('reclaim');
  q(rc, 'b').textContent = r ? size(r.bytes) : '—';
  q(rc, 'small').textContent = !r ? 'ölçülüyor…' : r.bytes < 100 * 2 ** 20 ? 'sistem temiz' : `açılabilir · en çok ${CLEAN[r.top] ? CLEAN[r.top][0].toLowerCase() : ''}`;
  for (const w of layout.widgets) {
    try { W[w.type].update(w.el, s, variantOf(w)); } catch (e) { console.error(w.type, e); }
  }
}

// --- düzenleme modu ---
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
}
$('doneBtn').addEventListener('click', () => setEditing(false));
function nextTheme() {
  const keys = Object.keys(THEMES);
  layout.theme = keys[(keys.indexOf(layout.theme) + 1) % keys.length] || keys[0];
  applyTheme(); save(); if (last) render(last);
}
$('themeBtn').addEventListener('click', nextTheme);

// --- ekran profilleri: düzeni adıyla kaydet, sonra tek dokunuşla geri aç ---
const profName = () => (profiles.find((p) => p.id === activeProf) || { name: 'PROFİL YOK' }).name.toLocaleUpperCase('tr-TR');
function drawProf() {
  $('profBtn').textContent = profName() + ' ▾';
  $('profList').innerHTML = profiles.map((p) =>
    `<div class="crow${p.id === activeProf ? ' sel' : ''}" data-id="${p.id}"><span class="box"></span><span>${esc(p.name)}<small>${p.id === activeProf ? 'şu an açık' : 'dokun: bu düzeni aç'}</small></span><button class="del" data-del="${p.id}" aria-label="Sil">✕</button></div>`).join('')
    || '<div class="sub">Kayıtlı profil yok — düzenleme çubuğundaki KAYDET ile oluştur</div>';
}
const layoutBody = () => {
  const { theme, g, sound, toast, dock, vol, tone } = layout;
  return { theme, g, sound, toast, dock, vol, tone, widgets: layout.widgets.map(({ id, type, x, y, w, h, variant }) => ({ id, type, x, y, w, h, variant })) };
};
async function prof(body) {
  try {
    const r = await (await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (!r.ok) return null;
    profiles = r.profiles; activeProf = r.active;
    drawProf();
    return r;
  } catch { return null; }
}
function flash(btn, text) {
  btn.dataset.t = btn.dataset.t || btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.t; }, 1600);
}
async function loadProf(id) {
  const r = await prof({ op: 'load', id });
  if (!r) return;
  // Ses ve bildirim ayarları profile bağlı değildir; şu anki hâliyle kalır.
  const { sound, toast, dock, vol, tone } = layout;
  setLayout({ ...r.layout, sound, toast, dock, vol, tone }); save();
}
$('profSave').addEventListener('click', async () => {
  flash($('profSave'), (await prof({ op: 'save', id: activeProf, layout: layoutBody() })) ? 'KAYDEDİLDİ ✓' : 'KAYDEDİLEMEDİ');
});
$('profNew').addEventListener('click', async () => {
  flash($('profNew'), (await prof({ op: 'save', layout: layoutBody() })) ? profName() + ' ✓' : 'EN ÇOK 12 PROFİL');
});
$('profBtn').addEventListener('click', () => { drawProf(); $('profSheet').hidden = false; });
$('profClose').addEventListener('click', () => { $('profSheet').hidden = true; });
$('profList').addEventListener('click', async (e) => {
  const del = e.target.dataset.del;
  if (del) { // iki dokunuş: yanlışlıkla silmeyi önler
    if (!e.target.classList.contains('arm')) { e.target.classList.add('arm'); e.target.textContent = 'SİL?'; return; }
    await prof({ op: 'delete', id: del });
    return;
  }
  const row = e.target.closest('.crow');
  if (row && row.dataset.id !== activeProf) { await loadProf(row.dataset.id); $('profSheet').hidden = true; }
});

// --- ayarlar ekranı ---
function drawSettings() {
  const onoff = (v) => `<span class="val${v ? '' : ' off'}">${v ? 'AÇIK' : 'KAPALI'}</span>`;
  const row = (k, name, note, val, on) => `<div class="crow${on ? ' sel' : ''}" data-k="${k}"><span class="box"></span><span>${name}<small>${note}</small></span>${val}</div>`;
  const plain = (k, name, note, val) => row(k, name, note, val).replace('<span class="box"></span>', '<span></span>');
  $('setList').innerHTML =
    row('sound', 'Bitti sesi', 'Bir iş bitince ses çalar', onoff(layout.sound), layout.sound)
    + row('toast', 'Ekran bildirimi', 'Ekranın üstünde “İŞ TAMAM” yazısı çıkar', onoff(layout.toast), layout.toast)
    + row('dock', 'Alt şerit', 'Açık pencereler ekranın altında; dokununca öne gelir', onoff(layout.dock), layout.dock)
    + plain('tone', 'Ses türü', 'Dokun: sıradaki sese geç ve dinle', `<span class="val">${(TONES[layout.tone] || TONES.cift)[0]}</span>`)
    + plain('vol', 'Ses seviyesi', 'Tabletin kendi ses düzeyi de etkiler', `<span class="val"><button data-v="-1">−</button><i>${layout.vol}</i><button data-v="1">+</button></span>`)
    + plain('test', 'Sesi dene', 'Seçili sesi şimdi çalar', '<span class="val">▶ ÇAL</span>')
    + plain('profile', 'Ekran profili', 'Dokun: sıradaki kayıtlı düzene geç', `<span class="val">${esc(profName())}</span>`)
    + plain('theme', 'Renk teması', 'Dokun: sıradaki temaya geç', `<span class="val">${THEMES[layout.theme] || ''}</span>`);
}
$('setBtn').addEventListener('click', () => { drawSettings(); $('setSheet').hidden = false; });
$('setClose').addEventListener('click', () => { $('setSheet').hidden = true; });
$('setEdit').addEventListener('click', () => { $('setSheet').hidden = true; setEditing(true); });
$('setList').addEventListener('click', (e) => {
  const row = e.target.closest('.crow');
  if (!row) return;
  const k = row.dataset.k;
  if (k === 'sound' || k === 'toast' || k === 'dock') layout[k] = !layout[k];
  if (k === 'dock' && last) render(last);
  if (k === 'tone') { const ks = Object.keys(TONES); layout.tone = ks[(ks.indexOf(layout.tone) + 1) % ks.length] || ks[0]; }
  if (k === 'vol') { if (!e.target.dataset.v) return; layout.vol = clamp(layout.vol + Number(e.target.dataset.v), 0, 10); }
  if (k === 'theme') { nextTheme(); drawSettings(); return; }
  if (k === 'profile') {
    if (profiles.length > 1) loadProf(profiles[(profiles.findIndex((p) => p.id === activeProf) + 1) % profiles.length].id).then(drawSettings);
    return;
  }
  if (k !== 'toast' && k !== 'dock' && (k !== 'sound' || layout.sound)) chime(false);
  if (k !== 'test') save();
  drawSettings();
});
let resetArmed = 0;
$('resetBtn').addEventListener('click', () => {
  // İki kez dokunma: yanlışlıkla sıfırlamayı önler.
  if (Date.now() - resetArmed > 3000) { resetArmed = Date.now(); $('resetBtn').textContent = 'EMİN MİSİN?'; setTimeout(() => { $('resetBtn').textContent = 'SIFIRLA'; }, 3000); return; }
  resetArmed = 0; $('resetBtn').textContent = 'SIFIRLA';
  setLayout(DEFAULT()); save();
});

const byEl = (el) => layout.widgets.find((w) => w.el === el);
let drag = null;
grid.addEventListener('pointerdown', (e) => {
  if (!editing) return;
  const ed = e.target.closest('.ed');
  const act = e.target.dataset.act;
  if (!ed || act === 'del' || act === 'var') return;
  const w = byEl(ed.parentElement), r = grid.getBoundingClientRect();
  drag = { w, resize: act === 'rs', sx: e.clientX, sy: e.clientY, o: { x: w.x, y: w.y, w: w.w, h: w.h }, cw: r.width / COLS, ch: r.height / ROWS };
  ed.setPointerCapture(e.pointerId);
  w.el.classList.add('drag');
  e.preventDefault();
});
grid.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { w, o } = drag, min = W[w.type].min;
  const dx = Math.round((e.clientX - drag.sx) / drag.cw), dy = Math.round((e.clientY - drag.sy) / drag.ch);
  if (drag.resize) { w.w = clamp(o.w + dx, min[0], COLS - w.x); w.h = clamp(o.h + dy, min[1], ROWS - w.y); }
  else { w.x = clamp(o.x + dx, 0, COLS - w.w); w.y = clamp(o.y + dy, 0, ROWS - w.h); }
  place(w);
  w.el.classList.toggle('bad', collides(w));
});
function endDrag() {
  if (!drag) return;
  const { w, o } = drag;
  if (collides(w)) Object.assign(w, o); // başka widget'ın üstüne bırakılamaz: eski yerine döner
  place(w);
  w.el.classList.remove('drag', 'bad');
  drag = null;
  save(); if (last) render(last);
}
grid.addEventListener('pointerup', endDrag);
grid.addEventListener('pointercancel', endDrag);

grid.addEventListener('click', async (e) => {
  if (editing) {
    const act = e.target.dataset.act, w = byEl(e.target.closest('.p'));
    if (!w) return;
    if (act === 'del') { layout.widgets = layout.widgets.filter((x) => x !== w); w.el.remove(); save(); }
    if (act === 'var') {
      const vs = W[w.type].variants;
      w.variant = vs[(vs.indexOf(variantOf(w)) + 1) % vs.length];
      fillBody(w); save(); if (last) render(last);
    }
    return;
  }
  const vc = e.target.dataset.v;
  if (vc) {
    const a = volNow(last);
    if (!a) return;
    if (vc === 'mute') setVol(null, !a.mute);
    else setVol(a.vol + (vc === 'up' ? 5 : -5), a.mute && vc === 'up' ? false : null);
    return;
  }
  const mc = e.target.dataset.m;
  if (mc) {
    fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: mc }) }).catch(() => {});
    return;
  }
  const sw = e.target.dataset.sw, sww = sw && byEl(e.target.closest('.p'));
  if (sww && sww.variant !== sw) { sww.variant = sw; fillBody(sww); save(); if (last) render(last); return; }
  const it = e.target.closest('.item[data-hwnd]');
  if (it) focusWindow(it);
});

grid.addEventListener('input', (e) => { if (!editing && e.target.classList.contains('vs')) setVol(+e.target.value); });

// --- widget ekleme ---
function freeSpot(type) {
  for (const [w, h] of [W[type].size, W[type].min]) {
    for (let y = 0; y + h <= ROWS; y++) for (let x = 0; x + w <= COLS; x++) {
      const c = { x, y, w, h };
      if (!collides(c)) return c;
    }
  }
  return null;
}
$('addBtn').addEventListener('click', () => {
  $('addMsg').textContent = '';
  $('addList').innerHTML = Object.entries(W).map(([type, d]) => {
    const n = layout.widgets.filter((w) => w.type === type).length;
    return `<div class="crow add" data-type="${type}"><span class="box">+</span><span>${d.title}<small>${d.note}${d.variants ? ` · ${d.variants.length} tasarım` : ''}</small></span><span class="sz dim">${n ? n + ' adet ekranda' : ''}</span></div>`;
  }).join('');
  $('addSheet').hidden = false;
});
$('addClose').addEventListener('click', () => { $('addSheet').hidden = true; });
$('addList').addEventListener('click', (e) => {
  const row = e.target.closest('.crow');
  if (!row) return;
  const type = row.dataset.type, spot = freeSpot(type);
  if (!spot) { $('addMsg').textContent = 'Boş yer yok — önce bir widget’ı küçült ya da kaldır'; return; }
  layout.widgets.push({ id: `${type}-${Date.now().toString(36)}`, type, ...spot });
  $('addSheet').hidden = true;
  buildAll(); save();
});

// --- veri akışı ---
function setLink(ok) {
  const e = $('link');
  e.textContent = ok ? 'USB BAĞLI' : 'BAĞLANTI YOK';
  e.classList.toggle('off', !ok);
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => {
    const o = JSON.parse(e.data);
    hist = o.hist; last = o.state; lastAt = Date.now(); setLink(true);
    profiles = o.profiles || []; activeProf = o.active || null; drawProf();
    lastNotice = Math.max(lastNotice, ...last.notices.map((n) => n.id)); // eski bildirimler yeniden çalmaz
    if (!editing) setLayout(o.layout); else render(last); // düzenlerken yeniden bağlanırsa yarım işi bozma
  });
  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    const add = (k, v) => { hist[k].push(v); if (hist[k].length > HIST) hist[k].shift(); };
    add('cpu', s.cpu.total); add('mem', (s.mem.used / s.mem.total) * 100); add('gpu', s.gpu ? s.gpu.util : 0);
    add('rx', s.net.rx); add('tx', s.net.tx);
    last = s; lastAt = Date.now(); setLink(true);
    announce(s.notices);
    if (layout && !drag) render(s);
  };
  es.onerror = () => setLink(false); // EventSource kendiliğinden yeniden bağlanır
}

// --- temizlik ekranı: önce tara, boyutları göster, onaydan sonra sil ---
const CLEAN = {
  temp: ['Geçici dosyalar', 'Geçici klasörde 1 günden eski dosyalar', true],
  browser: ['Tarayıcı önbelleği', 'Chrome / Edge / Brave — açık tarayıcının kilitli dosyaları atlanır', true],
  npm: ['npm önbelleği', 'Paketler sonraki kurulumda yeniden indirilir', false],
  dns: ['DNS önbelleği', 'ipconfig /flushdns', true],
  recycle: ['Çöp / Geri Dönüşüm Kutusu', 'Kalıcı olarak silinir, geri alınamaz', false],
};
// Bu bilgisayarın desteklediği hedefler (ör. macOS'ta DNS yok), hızlıdan yavaşa.
const cleanIds = () => ['dns', 'recycle', 'browser', 'temp', 'npm'].filter((id) => !last || last.cleanIds.includes(id));
const sel = new Set();
let scan = [], cleanMode = 'idle';
function drawClean() {
  $('cleanList').innerHTML = Object.entries(CLEAN).filter(([id]) => cleanIds().includes(id)).map(([id, [name, note]]) => {
    const it = scan.find((x) => x.id === id);
    const txt = !it ? '…' : cleanMode === 'done' && sel.has(id)
      ? (id === 'dns' ? 'temizlendi' : `${size(it.freed)} açıldı`)
      : id === 'dns' ? `${it.count} kayıt` : it.bytes || !it.count ? `${size(it.bytes)} · ${it.count} öğe` : `${it.count} öğe`;
    return `<div class="crow${sel.has(id) ? ' sel' : ''}" data-id="${id}"><span class="box"></span><span>${name}<small>${note}</small></span><span class="sz${cleanMode === 'done' && sel.has(id) ? ' done' : ''}">${txt}</span></div>`;
  }).join('');
  const total = scan.filter((x) => sel.has(x.id)).reduce((s, x) => s + (cleanMode === 'done' ? x.freed : x.bytes), 0);
  $('cleanTotal').textContent = cleanMode === 'done' ? `Toplam ${size(total)} yer açıldı` : scan.length ? `Seçili: ${size(total)}` : '';
  $('cleanState').textContent = { scan: 'taranıyor…', run: 'temizleniyor…', done: 'bitti', error: 'hata — tekrar dene' }[cleanMode] || '';
  $('cleanGo').disabled = cleanMode !== 'idle' || !sel.size;
  $('cleanClose').disabled = cleanMode === 'scan' || cleanMode === 'run';
}
async function openClean() {
  $('sheet').hidden = false;
  sel.clear(); cleanIds().forEach((id) => CLEAN[id][2] && sel.add(id));
  scan = []; cleanMode = 'scan'; drawClean();
  try {
    for (const id of cleanIds()) {
      const r = await (await fetch('/api/clean/scan?id=' + id)).json();
      if (!r.ok) throw 0;
      scan.push(...r.items); drawClean();
    }
    cleanMode = 'idle';
  } catch { cleanMode = 'error'; }
  drawClean();
}
$('cleanBtn').addEventListener('click', openClean);
$('cleanClose').addEventListener('click', () => { $('sheet').hidden = true; });
$('cleanList').addEventListener('click', (e) => {
  const row = e.target.closest('.crow');
  if (!row || cleanMode !== 'idle') return;
  sel.has(row.dataset.id) ? sel.delete(row.dataset.id) : sel.add(row.dataset.id);
  drawClean();
});
$('cleanGo').addEventListener('click', async () => {
  cleanMode = 'run'; drawClean();
  try {
    const r = await (await fetch('/api/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [...sel] }) })).json();
    if (r.ok) { scan = scan.map((x) => r.items.find((y) => y.id === x.id) || x); cleanMode = 'done'; } else cleanMode = 'error';
  } catch { cleanMode = 'error'; }
  drawClean();
});

// --- ekranı açık tutma, saat ---
let wake = null;
async function keepAwake() { // localhost güvenli bağlam sayıldığı için çalışır
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; } } catch { /* desteklenmiyor */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
document.addEventListener('click', keepAwake);
setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('tr-TR');
  if (Date.now() - lastAt > 4000) setLink(false);
}, 500);
addEventListener('resize', () => last && layout && render(last));
keepAwake();
connect();
