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

const KIND_LABEL = { video: 'VIDEO', audio: 'AUDIO', hls: 'HLS', dash: 'DASH', blob: 'BLOB' };
const SOURCE_LABEL = { network: 'сүлжээ', dom: 'хуудас', json: 'хуудасны өгөгдөл', link: 'линк' };

function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function canDownload(it) {
  return it.kind === 'video' || it.kind === 'audio' || it.kind === 'hls';
}

// Нэг видеоны олон чанарыг нэг бүлэгт нэгтгэнэ. Бүлэг бүрт хамгийн сайныг нь "best" болгоно.
let groups = []; // [{ best: idx, variants: [idx, ...] }]
let isCurrent = () => false;

function score(it) {
  // Дуутай видео > дуугүй видео > аудио. Дараа нь чанар (өндөр), bitrate, хэмжээгээр.
  const tier = it.kind === 'audio' ? 0 : (it.hasAudio ? 2 : 1);
  return [tier, it.qh || 0, it.bitrate || 0, it.size || 0];
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
  isCurrent = (g) => [g.best].concat(g.variants)
    .some((i) => items[i].videoId && pageUrl.includes(items[i].videoId));
  const order = { video: 0, audio: 1, hls: 2, dash: 3, blob: 4 };
  groups.sort((a, b) => (isCurrent(b) - isCurrent(a)) || (order[items[a.best].kind] - order[items[b.best].kind])
    || ((items[b.best].size || 0) - (items[a.best].size || 0)));
  tagGroups();
}

// Видеоны ID: Facebook-ийн холбоосноос, эсвэл ганц видеотой бол хуудасны хаягнаас (reel/123…)
function pageVideoId() {
  const m = pageUrl.match(/\/(?:reel|reels|videos|watch)\/(?:\?v=)?(\d{6,})/) || pageUrl.match(/[?&]v=(\d{6,})/);
  return m ? m[1] : '';
}
function tagGroups() {
  const usableGroups = groups.filter((g) => canDownload(items[g.best]));
  groups.forEach((g) => {
    const all = [g.best].concat(g.variants);
    let vid = (all.map((i) => items[i].videoId).find(Boolean)) || '';
    if (!vid && (usableGroups.length === 1 || isCurrent(g))) vid = pageVideoId();
    all.forEach((i) => { items[i].gvid = vid; items[i].isBest = i === g.best; });
  });
}

// Файлын нэр: amg-video-download-<видео ID> (шилдэгээс бусад нь -720p гэх мэт чанартай)
function baseNameOf(it, mode) {
  const q = it.kind === 'audio' ? 'audio' : qualityText(it);
  if (it.gvid) {
    const base = `amg-video-download-${it.gvid}`;
    return it.isBest || !q || mode === 'mp3' && it.kind === 'audio' ? base : `${base}-${q}`;
  }
  return q && mode !== 'mp3' ? `${pageTitle} ${q}` : pageTitle;
}

function foundText() {
  const n = groups.filter((g) => canDownload(items[g.best])).length;
  if (!n) return '';
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

// Видеоны жижиг зураг: эхний хэсгийг нь харуулна, хулгана аваачихад дуугүй тоглоно
function makeThumb(it) {
  const box = document.createElement('div');
  box.className = 'thumb';
  if (it.kind === 'audio') { box.textContent = '🎵'; box.classList.add('ph'); return box; }
  if (it.kind !== 'video') { box.textContent = '🎬'; box.classList.add('ph'); return box; }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.src = `${it.url}#t=0.5`;
  const dur = document.createElement('span');
  dur.className = 'dur';
  if (it.duration) dur.textContent = fmtDur(it.duration);
  v.addEventListener('loadedmetadata', () => {
    if (!dur.textContent && isFinite(v.duration)) dur.textContent = fmtDur(v.duration);
    box.classList.toggle('wide', v.videoWidth > v.videoHeight);
  });
  v.addEventListener('error', () => { box.textContent = '🎬'; box.classList.add('ph'); });
  box.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
  box.addEventListener('mouseleave', () => { v.pause(); });
  // Зураг дээр дарахад тухайн мөрийг сонгоно/болиулна
  box.addEventListener('click', () => {
    const li = box.closest('li');
    const cb = li && li.querySelector('input[type="checkbox"]');
    if (cb && !cb.disabled) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
  });
  box.title = 'Хулгана аваачихад урьдчилан харна, дарахад сонгоно';
  box.append(v, dur);
  return box;
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
  if (it.kind === 'video' && it.hasAudio) bits.push('🔊 дуутай');
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
  const usableGroups = groups.filter((g) => canDownload(items[g.best]));
  groups.forEach((g) => {
    const it = items[g.best];
    const li = document.createElement('li');
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
    if (it.kind === 'video' && it.hasAudio) info.push('🔊 дуутай');
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

    li.append(cb, makeThumb(it), meta);
    ul.append(li);
  });
  $('selectAll').checked = false;
  updateButton();
}

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
  document.querySelectorAll('#list input.best:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
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
    const mi = kind === 'blob' ? {} : AMG.mediaInfo(url);
    // Ижил видеоны ижил кодлолыг (өөр параметртэй холбоос) нэг гэж үзнэ
    const key = mi.group && mi.tag ? `${mi.group}|${mi.tag}` : url;
    const prev = map.get(key);
    if (prev) {
      ['width', 'height', 'duration', 'size', 'label', 'mime'].forEach((k) => { if (!prev[k] && r[k]) prev[k] = r[k]; });
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
      if (rep && rep.quality) it.quality = rep.quality;
      const qm = (it.quality || '').match(/(\d{3,4})p/);
      it.qh = qm ? Number(qm[1]) : (mi.height || 0);
      if (!it.quality && mi.height) it.quality = `${mi.height}p`;
    } else if (/progressive_url|hd_src|sd_src|playable_url|browser_native/.test(r.label || '')) {
      it.hasAudio = true; // Facebook-ийн эдгээр холбоос дүрс+дуу хамт байдаг
      it.mediaKnown = true;
    }
    if (!it.qh && it.height) it.qh = Math.min(it.width || it.height, it.height);
    map.set(key, it);
  });
  return [...map.values()];
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
  const skipped = [];

  sel.forEach((it) => {
    if (mode === 'mp3') {
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
        name: AMG.fileName(nameFor(it), mode === 'mp3' ? 'mp3' : AMG.guessExt(it), 0),
      })),
    });
  }
  const withName = (it) => Object.assign({}, it, { baseName: nameFor(it) });
  if (mp3Jobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'mp3', items: mp3Jobs.map(withName), title: pageTitle } });
  if (hlsJobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'hls', items: hlsJobs.map(withName), title: pageTitle } });

  const parts = [];
  if (direct.length) parts.push(`${direct.length} файл татагдаж эхэллээ`);
  if (mp3Jobs.length) parts.push(`${mp3Jobs.length} файл MP3 болгох цонхонд шилжлээ`);
  if (hlsJobs.length) parts.push(`${hlsJobs.length} HLS урсгал татах цонхонд шилжлээ`);
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

// ---------- Эхлэх ----------
(async () => {
  if (params.get('url')) {
    loadLink(params.get('url'));
  } else if (params.get('tab')) {
    loadTab(Number(params.get('tab')));
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) loadTab(tab.id);
  }
})();
