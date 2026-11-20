/* global AMG */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isWindow = params.has('tab') || params.has('url');
if (isWindow) document.body.classList.add('window');
if (params.get('mode') === 'mp3') $('format').value = 'mp3';

let items = [];
let pageTitle = 'amg-video';
let currentTabId = null;
let pageUrl = '';

function setStatus(text, err) {
  $('status').textContent = text || '';
  $('status').classList.toggle('err', !!err);
}

const KIND_LABEL = { video: 'VIDEO', audio: 'AUDIO', hls: 'HLS', dash: 'DASH', blob: 'BLOB', image: 'ЗУРАГ' };
const SOURCE_LABEL = { network: 'сүлжээ', dom: 'хуудас', json: 'хуудасны өгөгдөл', link: 'линк' };

function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function canDownload(it) {
  return it.kind === 'video' || it.kind === 'audio' || it.kind === 'hls' || it.kind === 'image';
}
// Видео/аудио (зурагнаас бусад) татаж болох медиа
function isMedia(it) {
  return it.kind !== 'image' && canDownload(it);
}

// Нэг видеоны олон чанарыг нэг бүлэгт нэгтгэнэ. Бүлэг бүрт хамгийн сайныг нь "best" болгоно.
let groups = []; // [{ best: idx, variants: [idx, ...] }]
let isCurrent = () => false;

// AV1 эсэх: manifest-ийн codecs (av01…) байвал түүгээр, үгүй бол кодлолын нэрээр
// ("r2av1-r1gen2vp9" нь VP9 ч байж болох тул codecs-ийг түрүүлж үзнэ)
function isAv1(x) {
  if (x.codecs) return /^av01/i.test(x.codecs);
  return /(^|[_-])av1/i.test(x.encTag || '') && !/vp9/i.test(x.encTag || '');
}

function score(it) {
  // Дуутай видео > дуугүй видео > аудио. Дараа нь чанар (өндөр), bitrate, хэмжээгээр.
  const tier = it.kind === 'audio' ? 0 : (it.hasAudio ? 2 : 1);
  // Нийлүүлсэн AV1 хувилбар Windows-ийн зарим тоглуулагчид тоглохгүй тул шилдэг болгохгүй
  const compat = it.merge && isAv1(it) ? 0 : 1;
  return [tier, compat, it.qh || 0, it.bitrate || 0, it.size || 0];
}
function cmpScore(a, b) {
  const x = score(a);
  const y = score(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

function buildGroups() {
  const map = new Map();
  items.forEach((it, i) => {
    const key = it.group || `u_${i}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  groups = [...map.values()].map((idxs) => {
    const usable = idxs.filter((i) => canDownload(items[i])).sort((a, b) => cmpScore(items[a], items[b]));
    const rest = idxs.filter((i) => !canDownload(items[i]));
    if (!usable.length) return { best: rest[0], variants: rest.slice(1) };
    // Бусад чанарыг өндрөөс нь бага руу, дууг хамгийн сүүлд
    const vs = usable.slice(1).sort((a, b) => ((items[a].kind === 'audio') - (items[b].kind === 'audio'))
      || ((items[b].qh || 0) - (items[a].qh || 0)) || ((items[b].size || 0) - (items[a].size || 0)));
    return { best: usable[0], variants: vs.concat(rest) };
  });
  // Одоо нээлттэй байгаа видео (хаягт нь video_id байвал) хамгийн дээр
  // эсвэл хуудсан дээр яг одоо тоглож байгаа видео (Instagram, TikTok гэх мэт)
  isCurrent = (g) => [g.best].concat(g.variants)
    .some((i) => (items[i].videoId && pageUrl.includes(items[i].videoId)) || items[i].playing);
  const order = { video: 0, audio: 1, hls: 2, dash: 3, blob: 4, image: 5 };
  groups.sort((a, b) => (isCurrent(b) - isCurrent(a)) || (order[items[a.best].kind] - order[items[b.best].kind])
    || ((items[b.best].size || 0) - (items[a.best].size || 0)));
  tagGroups();
}

// Видеоны ID: Facebook-ийн холбоосноос, эсвэл ганц видеотой бол хуудасны хаягнаас (reel/123…)
const PAGE_ID_PATTERNS = [
  // Facebook: /reel/123…, /videos/123…, watch/?v=123…
  /facebook\.com\/(?:.*\/)?(?:reel|reels|videos|watch)\/(?:\?v=)?(\d{6,})/,
  /facebook\.com\/.*[?&]v=(\d{6,})/,
  // Instagram: /reel/ABC…, /p/ABC…, /tv/ABC… (хэрэглэгчийн нэртэй хаяг ч болно)
  /instagram\.com\/(?:[^/?#]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/,
  // TikTok: /@user/video/123…
  /tiktok\.com\/@[^/?#]+\/(?:video|photo)\/(\d{6,})/,
  /tiktok\.com\/(?:.*\/)?v\/(\d{6,})/,
  // YouTube: watch?v=…, shorts/…, youtu.be/…
  /youtube\.com\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/,
  /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
  // Бусад: ?v=123…
  /[?&]v=(\d{6,})/,
];
function pageVideoId() {
  for (const re of PAGE_ID_PATTERNS) {
    const m = pageUrl.match(re);
    if (m) return m[1];
  }
  return '';
}
function tagGroups() {
  const usableGroups = groups.filter((g) => isMedia(items[g.best]));
  groups.forEach((g) => {
    const all = [g.best].concat(g.variants);
    let vid = (all.map((i) => items[i].videoId).find(Boolean)) || '';
    if (!vid && (usableGroups.length === 1 || isCurrent(g))) vid = pageVideoId();
    all.forEach((i) => { items[i].gvid = vid; items[i].isBest = i === g.best; });
  });
}

// Файлын нэр: amg-video-download-<видео ID> (шилдэгээс бусад нь -720p гэх мэт чанартай)
// Зургийн өргөтгөл (зураг биш бол '')
function imageExt(it) {
  if (it.kind !== 'image') return '';
  const e = AMG.extOf(it.url);
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'].includes(e)) return e;
  const m = (it.url.match(/[?&](?:format|fm|stp)=[^&]*?(jpg|jpeg|png|webp|gif|avif)/i) || [])[1];
  return m ? m.toLowerCase() : 'jpg';
}

// Зургийн өөрийн нэр: холбоосны сүүлийн хэсэг (жишээ нь 901076281_1682…_n.jpg → 901076281_1682…_n)
function imageOwnName(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const base = AMG.safeName(last.replace(/\.[a-z0-9]{2,5}$/i, ''), 120);
    // Утгагүй богино нэр (image, photo, 1 гэх мэт) бол хэрэглэхгүй
    return base && base !== 'amg-video' && base.length >= 4 ? base : '';
  } catch (e) {
    return '';
  }
}

function baseNameOf(it, mode) {
  if (it.kind === 'image') {
    const own = imageOwnName(it.url);
    if (own) return own;
    const id = pageVideoId();
    return `${id ? `amg-video-download-${id}` : pageTitle}-img`;
  }
  const q = it.kind === 'audio' ? 'audio' : qualityText(it);
  if (it.gvid) {
    const base = `amg-video-download-${it.gvid}`;
    return it.isBest || !q || mode === 'mp3' && it.kind === 'audio' ? base : `${base}-${q}`;
  }
  return q && mode !== 'mp3' ? `${pageTitle} ${q}` : pageTitle;
}

function foundText() {
  const n = groups.filter((g) => isMedia(items[g.best])).length;
  if (!n) return '';
  if (groups.some(isCurrent)) {
    return n > 1 ? `Одоо тоглож буй видео олдлоо (хуудсан дээр бусад ${n - 1} видео бий).` : 'Одоо тоглож буй видео олдлоо.';
  }
  const v = groups.reduce((s, g) => s + g.variants.length, 0);
  return `${n} медиа олдлоо${v ? ` (+${v} өөр чанар)` : ''}. Сонгоод татна уу.`;
}

function qualityText(it) {
  if (it.quality) return it.quality;
  if (it.qh) return `${it.qh}p`;
  if (it.width && it.height) return `${it.width}×${it.height}`;
  return '';
}

function makeCheckbox(i, cls) {
  const it = items[i];
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.disabled = !canDownload(it);
  cb.dataset.idx = i;
  if (cls) cb.className = cls;
  cb.addEventListener('change', updateButton);
  return cb;
}

// Жижиг зургийн нөөц холбоосууд: тухайн бүлгийн бусад видео (дуутай, бага чанартайг түрүүлж)
function thumbAlts(g) {
  return g.variants.map((i) => items[i]).filter((x) => x.kind === 'video')
    .sort((a, b) => ((a.hasAudio ? 0 : 1) - (b.hasAudio ? 0 : 1)) || ((a.qh || 0) - (b.qh || 0)))
    .map((x) => x.url);
}

// Видеоны жижиг зураг: эхний хэсгийг нь харуулна, хулгана аваачихад дуугүй тоглоно
function makeThumb(it, alts) {
  const box = document.createElement('div');
  box.className = 'thumb';
  if (it.kind === 'audio') { box.textContent = '🎵'; box.classList.add('ph'); return box; }
  if (it.kind === 'image') {
    // Зураг: дарахад сонгогдоно
    const img = document.createElement('img');
    img.src = it.url;
    img.loading = 'lazy';
    img.alt = '';
    img.addEventListener('load', () => box.classList.toggle('wide', img.naturalWidth > img.naturalHeight));
    img.addEventListener('error', () => { box.textContent = '🖼'; box.classList.add('ph'); });
    box.classList.add('img');
    box.append(img);
    return box;
  }
  if (it.kind !== 'video') { box.textContent = '🎬'; box.classList.add('ph'); return box; }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  // Ачаалагдахгүй бол (сүлжээ түр тасарсан, кодек гэх мэт) бусад чанарын холбоосыг, дараа нь
  // эхнийхийг 2 секундын дараа дахин оролдоно.
  const cands = [it.url].concat((alts || []).filter((u) => u && u !== it.url)).slice(0, 4);
  let ci = 0;
  let retried = false;
  v.src = `${cands[0]}#t=0.5`;
  const dur = document.createElement('span');
  dur.className = 'dur';
  if (it.duration) dur.textContent = fmtDur(it.duration);
  v.addEventListener('loadedmetadata', () => {
    if (!dur.textContent && isFinite(v.duration)) dur.textContent = fmtDur(v.duration);
    box.classList.toggle('wide', v.videoWidth > v.videoHeight);
  });
  v.addEventListener('error', () => {
    if (ci + 1 < cands.length) { ci++; v.src = `${cands[ci]}#t=0.5`; return; }
    if (!retried) {
      retried = true;
      ci = 0;
      setTimeout(() => { v.src = `${cands[0]}#t=0.5`; }, 2000);
      return;
    }
    box.textContent = '🎬';
    box.classList.add('ph');
    box.title = 'Урьдчилан харах зураг ачаалагдсангүй (сүлжээ эсвэл холбоосны хугацаа). Татахад нөлөөлөхгүй байж болно.';
  });
  box.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
  box.addEventListener('mouseleave', () => { v.pause(); });
  // Зураг дээр дарахад шинэ цонхонд дуутай тоглуулна
  const play = document.createElement('span');
  play.className = 'play';
  play.textContent = '▶';
  box.addEventListener('click', () => {
    v.pause();
    openPlayer(it, v.videoWidth, v.videoHeight);
  });
  box.title = 'Хулгана аваачихад урьдчилан харна. Дарахад шинэ цонхонд дуутай тоглоно';
  box.append(v, play, dur);
  return box;
}

// Тоглуулагч цонх: видеоны хэмжээнд тааруулж (босоо reel бол нарийн, өндөр) нээнэ
function openPlayer(it, vw, vh) {
  const w0 = vw || it.width || 16;
  const h0 = vh || it.height || 9;
  const maxH = Math.min(820, (screen.availHeight || 900) - 80);
  const maxW = Math.min(1280, (screen.availWidth || 1400) - 80);
  let h = maxH;
  let w = Math.round((h * w0) / h0);
  if (w > maxW) { w = maxW; h = Math.round((w * h0) / w0); }
  const q = new URLSearchParams({ v: it.url, t: baseNameOf(it, 'orig') });
  if (it.merge && it.audioUrl) q.set('a', it.audioUrl);
  chrome.windows.create({
    url: chrome.runtime.getURL(`player.html?${q}`), type: 'popup', width: Math.max(w, 320), height: h + 40, focused: true,
  });
}

function variantRow(i) {
  const it = items[i];
  const row = document.createElement('label');
  row.className = 'variant';
  if (!canDownload(it)) row.classList.add('disabled');
  row.title = it.url;
  const icon = document.createElement(it.kind === 'audio' ? 'span' : 'img');
  if (it.kind === 'audio') { icon.textContent = '🎵'; icon.className = 'vicon'; } else {
    icon.src = 'icons/video128.png';
    icon.className = 'vicon';
    icon.alt = '';
  }
  const q = document.createElement('b');
  q.textContent = it.kind === 'audio' ? 'Зөвхөн дуу' : (qualityText(it) || KIND_LABEL[it.kind] || it.kind);
  const small = document.createElement('span');
  small.className = 'small';
  const bits = [];
  if (it.size) bits.push(AMG.humanSize(it.size));
  if (it.kind === 'video' && it.mediaKnown && !it.hasAudio) bits.push('🔇 дуугүй');
  if (it.merge) bits.push('🔊 дүрс+дуу нийлүүлнэ');
  else if (it.kind === 'video' && it.hasAudio) bits.push('🔊 дуутай');
  small.textContent = bits.join(' · ');
  row.append(makeCheckbox(i), icon, q, small);
  return row;
}

function render() {
  const ul = $('list');
  ul.innerHTML = '';
  buildGroups();
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Медиа олдсонгүй.<br><span class="small">Видеог нэг удаа тоглуулаад ⟳ дарж дахин хайгаарай.</span></li>';
  }
  const usableGroups = groups.filter((g) => isMedia(items[g.best]));
  // Reels гүйлгэхэд Facebook дараагийн олон видеог урьдчилан ачаалдаг. Одоо тоглож байгаа нь
  // олдвол зөвхөн түүнийг харуулж, бусдыг нь "Бусад видео" товчны ард нууна.
  const hasCurrent = groups.some(isCurrent);
  const others = [];
  const images = [];
  groups.forEach((g) => {
    const it = items[g.best];
    if (it.kind === 'image') { images.push(g.best); return; }
    const li = document.createElement('li');
    if (hasCurrent && !isCurrent(g)) { li.hidden = true; li.classList.add('other'); others.push(li); }
    const ok = canDownload(it);
    if (!ok) li.classList.add('disabled');
    const cb = makeCheckbox(g.best, 'best');
    cb.checked = ok && (usableGroups.length === 1 || (g === groups[0] && isCurrent(g)));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const info = [];
    const q = qualityText(it);
    if (q) info.push(q);
    if (it.duration) info.push(fmtDur(it.duration));
    if (it.size) info.push(AMG.humanSize(it.size));
    if (it.merge) info.push('🔊 дуутай (дүрс+дуу нийлүүлнэ)');
    else if (it.kind === 'video' && it.hasAudio) info.push('🔊 дуутай');
    else if (it.kind === 'video' && it.mediaKnown) info.push('🔇 дуугүй');
    if (it.label && !it.quality) info.push(it.label);
    info.push(SOURCE_LABEL[it.source] || it.source);
    let note = '';
    if (it.kind === 'blob') note = ' — шууд татагдахгүй (blob). Видеог тоглуулаад ⟳ дарвал сүлжээний холбоос гарч ирнэ.';
    if (it.kind === 'dash') note = ' — DASH жагсаалт дэмжигдэхгүй, доорх video/audio холбоосыг сонгоно уу.';
    meta.innerHTML = `<div><span class="badge ${it.kind}">${KIND_LABEL[it.kind] || it.kind}</span>`
      + (g.variants.length && ok ? '<span class="badge star">★ Шилдэг</span>' : '')
      + `<span class="small"></span></div><div class="url"></div>`;
    meta.querySelector('.small').textContent = info.join(' · ') + note;
    meta.querySelector('.url').textContent = it.url;
    meta.querySelector('.url').title = it.url;

    if (g.variants.length) {
      const det = document.createElement('details');
      det.className = 'variants';
      const sum = document.createElement('summary');
      sum.textContent = `Бусад чанар (${g.variants.length})`;
      det.append(sum);
      g.variants.forEach((vi) => det.append(variantRow(vi)));
      meta.append(det);
    }

    li.dataset.base = baseNameOf(it, 'orig');
    // Нуугдсан мөрийн зургийг дэлгэхэд л ачаална
    if (li.hidden) li.__thumb = () => makeThumb(it, thumbAlts(g));
    li.append(cb, li.hidden ? document.createElement('span') : makeThumb(it, thumbAlts(g)), meta);
    ul.append(li);
  });
  if (others.length) {
    const more = document.createElement('li');
    more.className = 'more';
    const btn = document.createElement('button');
    btn.textContent = `Хуудсан дээрх бусад ${others.length} видеог харах ▾`;
    btn.addEventListener('click', () => {
      others.forEach((li) => {
        li.hidden = false;
        if (li.__thumb) { li.children[1].replaceWith(li.__thumb()); li.__thumb = null; }
      });
      more.remove();
    });
    more.append(btn);
    ul.append(more);
  }
  if (images.length) ul.append(imageSection(images, !usableGroups.length));
  $('selectAll').checked = false;
  updateButton();
  markDownloaded();
}

// ---------- Зураг (том хэмжээтэй) ----------
// Видеоны жагсаалтыг дүүргэхгүйн тулд тусдаа, эвхэгддэг хэсэгт харуулна.
// Хуудсан дээр видео байхгүй бол (зургийн пост гэх мэт) шууд дэлгэгдсэн байна.
function imageSection(idxs, open) {
  const li = document.createElement('li');
  li.className = 'images';
  const det = document.createElement('details');
  det.open = open;
  const sum = document.createElement('summary');
  sum.textContent = `🖼 Том хэмжээтэй зураг (${idxs.length})`;
  const all = document.createElement('label');
  all.className = 'small imgall';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  allCb.addEventListener('change', () => {
    det.querySelectorAll('input.img').forEach((c) => { c.checked = allCb.checked; });
    updateButton();
  });
  all.append(allCb, ' Бүх зургийг сонгох');
  const grid = document.createElement('div');
  grid.className = 'imggrid';
  idxs.forEach((i) => {
    const it = items[i];
    const cell = document.createElement('label');
    cell.className = 'imgcell';
    const cb = makeCheckbox(i, 'img');
    const box = makeThumb(it);
    const cap = document.createElement('span');
    cap.className = 'small';
    cap.textContent = it.width && it.height ? `${it.width}×${it.height}` : '';
    cell.title = it.url;
    cell.append(cb, box, cap);
    grid.append(cell);
  });
  det.append(sum, all, grid);
  li.append(det);
  return li;
}

// ---------- Татсан түүх ----------
let dlHistory = [];
// "amg-video-download-123 (1).mp4" → "amg-video-download-123"
const baseOfFile = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/\s\(\d+\)$/, '');

// Өмнө нь татсан видеоны мөрөнд "✓ Татсан" тэмдэг тавина (давхар татахаас сэргийлнэ)
function markDownloaded() {
  const done = new Set(dlHistory.map((h) => baseOfFile(h.name)));
  document.querySelectorAll('#list li[data-base]').forEach((li) => {
    const has = done.has(li.dataset.base);
    let b = li.querySelector('.badge.done');
    if (has && !b) {
      b = document.createElement('span');
      b.className = 'badge done';
      b.textContent = '✓ Татсан';
      b.title = 'Энэ видеог өмнө нь татсан байна';
      const first = li.querySelector('.meta > div');
      if (first) first.insertBefore(b, first.querySelector('.small'));
    } else if (!has && b) b.remove();
  });
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistory() {
  const ul = $('historyList');
  ul.innerHTML = '';
  $("historyCount").textContent = dlHistory.length ? `(${dlHistory.length})` : '';
  $("historyClear").hidden = !dlHistory.length;
  if (!dlHistory.length) {
    ul.innerHTML = '<li class="small">Одоогоор татсан файл алга.</li>';
    return;
  }
  dlHistory.slice(0, 30).forEach((h) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'hname';
    name.textContent = h.name;
    name.title = h.path || h.name;
    const small = document.createElement('span');
    small.className = 'small';
    small.textContent = [fmtTime(h.time), AMG.humanSize(h.size)].filter(Boolean).join(' · ');
    const show = document.createElement('button');
    show.textContent = '📂';
    show.title = 'Хавтсанд харах';
    show.addEventListener('click', () => chrome.downloads.show(h.id));
    const open = document.createElement('button');
    open.textContent = '▶';
    open.title = 'Нээх';
    open.addEventListener('click', async () => {
      const [d] = await chrome.downloads.search({ id: h.id });
      if (!d || d.exists === false) { setStatus(`Файл олдсонгүй (устгагдсан эсвэл зөөгдсөн): ${h.name}`, true); return; }
      chrome.downloads.open(h.id);
    });
    li.append(name, small, show, open);
    ul.append(li);
  });
}

async function loadHistory() {
  try {
    ({ history: dlHistory = [] } = await chrome.storage.local.get('history'));
  } catch (e) { dlHistory = []; }
  renderHistory();
  markDownloaded();
}
$('historyClear').addEventListener('click', async () => {
  await chrome.storage.local.remove('history');
  dlHistory = [];
  renderHistory();
  markDownloaded();
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.history) loadHistory(); });
loadHistory();

function selected() {
  return [...document.querySelectorAll('#list input[type=checkbox]:checked')].map((c) => items[+c.dataset.idx]);
}

function updateButton() {
  const n = selected().length;
  $('downloadBtn').disabled = n === 0;
  $('downloadBtn').textContent = n ? `Сонгосон ${n} файлыг татах` : 'Сонгосныг татах';
}

// "Бүгд" нь бүлэг бүрийн зөвхөн шилдэг хувилбарыг сонгоно
$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('#list input.best:not(:disabled)').forEach((c) => {
    if (!c.closest('li').hidden) c.checked = e.target.checked;
  });
  if (!e.target.checked) document.querySelectorAll('#list input[type=checkbox]').forEach((c) => { c.checked = false; });
  updateButton();
});

function normalize(raw, reps) {
  reps = reps || {};
  const map = new Map();
  raw.forEach((r) => {
    if (!r || !r.url) return;
    let kind = r.kind || AMG.classify(r.url, r.mime);
    if (!kind && r.tag) kind = r.tag === 'audio' ? 'audio' : 'video';
    if (!kind && r.source === 'json') kind = 'video';
    if (!kind) return;
    const url = kind === 'blob' ? r.url : AMG.cleanUrl(r.url);
    const mi = kind === 'blob' || kind === 'image' ? {} : AMG.mediaInfo(url);
    // Ижил видеоны ижил кодлолыг (өөр параметртэй холбоос) нэг гэж үзнэ
    const key = mi.group && mi.tag ? `${mi.group}|${mi.tag}` : url;
    const prev = map.get(key);
    if (prev) {
      ['width', 'height', 'duration', 'size', 'label', 'mime', 'playing'].forEach((k) => { if (!prev[k] && r[k]) prev[k] = r[k]; });
      if ((r.size || 0) > (prev.size || 0)) prev.size = r.size;
      return;
    }
    const it = Object.assign({}, r, { url, kind });
    if (mi.tag) {
      it.mediaKnown = true;
      it.group = mi.group;
      it.videoId = mi.videoId;
      it.encTag = mi.tag;
      it.bitrate = mi.bitrate;
      it.hasAudio = !!mi.hasAudio;
      if (!it.duration && mi.duration) it.duration = mi.duration;
      if (mi.audioOnly) it.kind = 'audio';
      const rep = reps[mi.tag];
      if (!it.quality && rep && rep.quality) it.quality = rep.quality;
      if (rep && !it.width) { it.width = rep.width; it.height = rep.height; }
      const qm = (it.quality || '').match(/(\d{3,4})p/);
      it.qh = qm ? Number(qm[1]) : (mi.height || 0);
      if (!it.quality && mi.height) it.quality = `${mi.height}p`;
    }
    if (/progressive_url|hd_src|sd_src|playable_url|browser_native|video_versions/.test(r.label || '')) {
      it.hasAudio = true; // Facebook-ийн эдгээр холбоос, Instagram-ийн video_versions дүрс+дуу хамт байдаг
      it.mediaKnown = true;
      if (it.kind === 'audio') it.kind = 'video';
    }
    // Instagram: холбоос аль reel/пост-ынх болохыг "code"-оор нь (хаягт байдаг) тодорхойлно
    if (r.igCode) {
      it.videoId = r.igCode;
      if (!it.group) it.group = `ig_${r.igCode}`;
    }
    if (!it.qh && it.height) it.qh = Math.min(it.width || it.height, it.height);
    map.set(key, it);
  });
  let list = [...map.values()];
  // blob: (Instagram, YouTube гэх мэт) холбоосыг шууд татах боломжгүй. Өөр татаж болох медиа
  // олдсон бол тэдгээрийг жагсаалтаас хасна.
  if (list.some((x) => isMedia(x))) list = list.filter((x) => x.kind !== 'blob');
  return addMerged(list);
}

// Facebook: өндөр чанарын дүрс нь дуугүй, дуу нь тусдаа ирдэг. Дуутай хувилбараас өндөр чанартай
// дүрс байвал "дүрс + дуу нийлүүлсэн" хувилбар нэмнэ (татахдаа job цонхонд нийлүүлнэ).
function addMerged(list) {
  const byGroup = new Map();
  list.forEach((it) => {
    if (!it.group) return;
    if (!byGroup.has(it.group)) byGroup.set(it.group, []);
    byGroup.get(it.group).push(it);
  });
  byGroup.forEach((arr) => {
    const audio = arr.filter((x) => x.kind === 'audio').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)
      || (b.size || 0) - (a.size || 0))[0];
    if (!audio) return;
    const silent = arr.filter((x) => x.kind === 'video' && x.mediaKnown && !x.hasAudio && x.qh);
    if (!silent.length) return;
    const withSound = Math.max(0, ...arr.filter((x) => x.kind === 'video' && x.hasAudio).map((x) => x.qh || 0));
    // AV1 биш (VP9/H.264) хамгийн өндрийг үндсэн болгоно. AV1 нь илүү өндөр бол нэмэлт сонголт болно.
    const top = (arr2) => arr2.sort((a, b) => (b.qh - a.qh) || ((b.size || 0) - (a.size || 0)))[0];
    const plain = top(silent.filter((x) => !isAv1(x)));
    const av1 = top(silent.filter(isAv1));
    [plain, av1 && (!plain || av1.qh > plain.qh) ? av1 : null].forEach((v) => {
      if (!v || v.qh <= withSound) return;
      list.push(Object.assign({}, v, {
        merge: true,
        audioUrl: audio.url,
        hasAudio: true,
        // Хоёулангийнх нь хэмжээ мэдэгдэж байвал л нийлбэрийг харуулна (эс бөгөөс буруу бага тоо гарна)
        size: v.size && audio.size ? v.size + audio.size : 0,
        label: '',
        quality: isAv1(v) ? `${v.quality || `${v.qh}p`} AV1` : v.quality,
      }));
    });
  });
  return list;
}

async function scanTab(tabId) {
  let scanned = [];
  let title = '';
  const reps = {};
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: AMG.scanPage,
    });
    results.forEach((r) => {
      if (!r || !r.result) return;
      if (r.frameId === 0) title = r.result.title;
      scanned = scanned.concat(r.result.items);
      Object.assign(reps, r.result.reps || {});
    });
  } catch (e) {
    // chrome:// гэх мэт хуудсанд скрипт ажиллахгүй
  }
  const sniffed = await chrome.runtime.sendMessage({ type: 'getSniffed', tabId });
  return { title, items: (sniffed || []).concat(scanned), reps };
}

async function loadTab(tabId) {
  currentTabId = tabId;
  setStatus('Хайж байна…');
  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title || pageTitle;
    pageUrl = tab.url || '';
    $('pageTitle').textContent = pageTitle;
  } catch (e) { /* ignore */ }
  const res = await scanTab(tabId);
  if (res.title) pageTitle = res.title;
  items = normalize(res.items, res.reps);
  render();
  setStatus(foundText());
}

function waitTabComplete(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(t); resolve(); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function probe(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    return { mime: r.headers.get('content-type') || '', size: Number(r.headers.get('content-length')) || 0 };
  } catch (e) {
    return { mime: '', size: 0 };
  } finally {
    clearTimeout(t);
  }
}

async function loadLink(url) {
  url = (url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    setStatus('http:// эсвэл https://-ээр эхэлсэн линк оруулна уу.', true);
    return;
  }
  $('linkInput').value = url;
  $('pageTitle').textContent = url;
  setStatus('Линкийг шалгаж байна…');
  items = [];
  render();

  let kind = AMG.classify(url, '');
  let info = { mime: '', size: 0 };
  if (!kind) {
    info = await probe(url);
    kind = AMG.classify(url, info.mime);
  }
  if (kind && kind !== 'blob') {
    pageTitle = decodeURIComponent((new URL(url).pathname.split('/').pop() || 'amg-video').replace(/\.[^.]+$/, ''));
    items = normalize([{ url, kind, mime: info.mime, size: info.size, source: 'link' }]);
    render();
    setStatus('Шууд медиа файл байна.');
    return;
  }

  // Энгийн хуудас бол ар талд нээж, медиаг барьж аваад хаана
  setStatus('Хуудсыг ар талд нээж медиа хайж байна… (10–20 сек)');
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 5000));
    const res = await scanTab(tab.id);
    pageTitle = res.title || pageTitle;
    $('pageTitle').textContent = pageTitle;
    items = normalize(res.items, res.reps);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  render();
  const n = groups.length;
  setStatus(n ? foundText() : 'Медиа олдсонгүй. Хуудсыг өөрөө нээж видеог тоглуулаад Amg-Video-Download-ыг дарж үзээрэй.', !n);
}

$('linkBtn').addEventListener('click', () => loadLink($('linkInput').value));
$('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLink($('linkInput').value); });
$('refreshBtn').addEventListener('click', () => {
  if (params.get('url') && !currentTabId) loadLink($('linkInput').value);
  else if (currentTabId != null) loadTab(currentTabId);
});

$('downloadBtn').addEventListener('click', async () => {
  const sel = selected();
  if (!sel.length) return;
  const mode = $('format').value;
  const direct = [];
  const mp3Jobs = [];
  const hlsJobs = [];
  const mergeJobs = [];
  const skipped = [];

  sel.forEach((it) => {
    if (it.kind === 'image') {
      direct.push(it); // зураг эх форматаараа (MP3 сонгосон ч)
    } else if (it.merge) {
      // MP3 бол зөвхөн тусдаа дууг нь хөрвүүлнэ
      if (mode === 'mp3') mp3Jobs.push(Object.assign({}, it, { url: it.audioUrl, kind: 'audio', merge: false }));
      else mergeJobs.push(it);
    } else if (mode === 'mp3') {
      if (it.kind === 'hls') skipped.push(it);
      else if (AMG.extOf(it.url) === 'mp3' || /audio\/mpeg/.test(it.mime || '')) direct.push(it);
      else mp3Jobs.push(it);
    } else if (it.kind === 'hls') {
      hlsJobs.push(it);
    } else {
      direct.push(it);
    }
  });

  // Нэр давхцвал -2, -3 гэж дугаарлана
  const used = new Map();
  const nameFor = (it) => {
    const b = baseNameOf(it, mode);
    const n = (used.get(b) || 0) + 1;
    used.set(b, n);
    return n > 1 ? `${b}-${n}` : b;
  };
  if (direct.length) {
    await chrome.runtime.sendMessage({
      type: 'download',
      items: direct.map((it) => ({
        url: it.url,
        name: AMG.fileName(nameFor(it), imageExt(it) || (mode === 'mp3' ? 'mp3' : AMG.guessExt(it)), 0),
      })),
    });
  }
  const withName = (it) => Object.assign({}, it, { baseName: nameFor(it) });
  if (mp3Jobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'mp3', items: mp3Jobs.map(withName), title: pageTitle } });
  if (hlsJobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'hls', items: hlsJobs.map(withName), title: pageTitle } });
  if (mergeJobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'merge', items: mergeJobs.map(withName), title: pageTitle } });

  const parts = [];
  if (direct.length) parts.push(`${direct.length} файл татагдаж эхэллээ`);
  if (mp3Jobs.length) parts.push(`${mp3Jobs.length} файл MP3 болгох цонхонд шилжлээ`);
  if (hlsJobs.length) parts.push(`${hlsJobs.length} HLS урсгал татах цонхонд шилжлээ`);
  if (mergeJobs.length) parts.push(`${mergeJobs.length} видеоны дүрс, дууг нийлүүлэх цонхонд шилжлээ`);
  if (skipped.length) parts.push(`${skipped.length} HLS урсгалыг MP3 болгох боломжгүй`);
  setStatus(parts.join('. ') + '.', !!skipped.length && !parts.length);
});

// ---------- Тохиргоо (хадгалах хавтас) ----------
async function loadSettingsUI() {
  const s = await AMG.getSettings();
  $('folderInput').value = s.folder;
  $('askLocation').checked = s.askLocation;
  $('folderInput').disabled = s.askLocation;
  $('folderNow').textContent = s.askLocation ? 'Хадгалах бүрт асууна' : `Downloads/${s.folder || ''}`;
}

async function saveSettingsUI() {
  await AMG.saveSettings({ folder: $('folderInput').value, askLocation: $('askLocation').checked });
  await loadSettingsUI();
  $('savedHint').textContent = 'Хадгаллаа ✓';
  setTimeout(() => { $('savedHint').textContent = ''; }, 1500);
}

$('folderInput').addEventListener('change', saveSettingsUI);
$('askLocation').addEventListener('change', saveSettingsUI);
$('folderReset').addEventListener('click', () => {
  $('folderInput').value = AMG.DEFAULT_SETTINGS.folder;
  $('askLocation').checked = false;
  saveSettingsUI();
});
loadSettingsUI();

// ---------- Гарын товчлол ----------
// Alt+Shift+D-ээр нээгдсэн бол: ганц тодорхой видео сонгогдсон байвал шууд татаад хаагдана
function autoDownload() {
  const sel = selected();
  if (sel.length === 1) {
    setStatus('Шилдэг чанараар татаж байна…');
    $('downloadBtn').click();
    setTimeout(() => window.close(), 2500);
  } else if (groups.some((g) => isMedia(items[g.best]))) {
    setStatus('Олон видео олдлоо. Хэрэгтэйгээ сонгоод Enter дарна уу.');
  }
}
// Enter: сонгосныг татах (линк бичих талбараас бусад үед)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.closest('input[type=text], input[type=url], select, button, summary')) return;
  if (!$('downloadBtn').disabled) { e.preventDefault(); $('downloadBtn').click(); }
});

// ---------- Эхлэх ----------
(async () => {
  if (params.get('url')) {
    loadLink(params.get('url'));
  } else if (params.get('tab')) {
    await loadTab(Number(params.get('tab')));
    if (params.get('auto')) autoDownload();
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) loadTab(tab.id);
  }
})();
