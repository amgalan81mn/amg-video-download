/* global AMG */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isWindow = params.has('tab') || params.has('url');
if (isWindow) document.body.classList.add('window');
if (params.get('mode') === 'mp3') $('format').value = 'mp3';

let items = [];
let pageTitle = 'amg-video';
let currentTabId = null;

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

function render() {
  const ul = $('list');
  ul.innerHTML = '';
  const usable = items.filter(canDownload);
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Медиа олдсонгүй.<br><span class="small">Видеог нэг удаа тоглуулаад ⟳ дарж дахин хайгаарай.</span></li>';
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const ok = canDownload(it);
    if (!ok) li.classList.add('disabled');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = !ok;
    cb.checked = ok && usable.length === 1;
    cb.dataset.idx = i;
    cb.addEventListener('change', updateButton);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const info = [];
    if (it.width && it.height) info.push(`${it.width}×${it.height}`);
    if (it.duration) info.push(fmtDur(it.duration));
    if (it.size) info.push(AMG.humanSize(it.size));
    if (it.label) info.push(it.label);
    info.push(SOURCE_LABEL[it.source] || it.source);
    let note = '';
    if (it.kind === 'blob') note = ' — шууд татагдахгүй (blob). Видеог тоглуулаад ⟳ дарвал сүлжээний холбоос гарч ирнэ.';
    if (it.kind === 'dash') note = ' — DASH жагсаалт дэмжигдэхгүй, доорх video/audio холбоосыг сонгоно уу.';
    meta.innerHTML = `<div><span class="badge ${it.kind}">${KIND_LABEL[it.kind] || it.kind}</span>`
      + `<span class="small"></span></div><div class="url"></div>`;
    meta.querySelector('.small').textContent = info.join(' · ') + note;
    meta.querySelector('.url').textContent = it.url;
    meta.querySelector('.url').title = it.url;

    li.append(cb, meta);
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

$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('#list input[type=checkbox]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
  updateButton();
});

function normalize(raw) {
  const map = new Map();
  raw.forEach((r) => {
    if (!r || !r.url) return;
    let kind = r.kind || AMG.classify(r.url, r.mime);
    if (!kind && r.tag) kind = r.tag === 'audio' ? 'audio' : 'video';
    if (!kind && r.source === 'json') kind = 'video';
    if (!kind) return;
    const url = kind === 'blob' ? r.url : AMG.cleanUrl(r.url);
    const prev = map.get(url);
    if (prev) {
      ['width', 'height', 'duration', 'size', 'label', 'mime'].forEach((k) => { if (!prev[k] && r[k]) prev[k] = r[k]; });
    } else {
      map.set(url, Object.assign({}, r, { url, kind }));
    }
  });
  const order = { video: 0, audio: 1, hls: 2, dash: 3, blob: 4 };
  return [...map.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || ((b.size || 0) - (a.size || 0)));
}

async function scanTab(tabId) {
  let scanned = [];
  let title = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: AMG.scanPage,
    });
    results.forEach((r) => {
      if (!r || !r.result) return;
      if (r.frameId === 0) title = r.result.title;
      scanned = scanned.concat(r.result.items);
    });
  } catch (e) {
    // chrome:// гэх мэт хуудсанд скрипт ажиллахгүй
  }
  const sniffed = await chrome.runtime.sendMessage({ type: 'getSniffed', tabId });
  return { title, items: (sniffed || []).concat(scanned) };
}

async function loadTab(tabId) {
  currentTabId = tabId;
  setStatus('Хайж байна…');
  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title || pageTitle;
    $('pageTitle').textContent = pageTitle;
  } catch (e) { /* ignore */ }
  const res = await scanTab(tabId);
  if (res.title) pageTitle = res.title;
  items = normalize(res.items);
  render();
  const n = items.filter(canDownload).length;
  setStatus(n ? `${n} медиа олдлоо. Сонгоод татна уу.` : '');
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
    items = normalize(res.items);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  render();
  const n = items.filter(canDownload).length;
  setStatus(n ? `${n} медиа олдлоо.` : 'Медиа олдсонгүй. Хуудсыг өөрөө нээж видеог тоглуулаад Amg-Video-Download-ыг дарж үзээрэй.', !n);
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

  const multi = sel.length > 1;
  if (direct.length) {
    await chrome.runtime.sendMessage({
      type: 'download',
      items: direct.map((it, i) => ({
        url: it.url,
        name: AMG.fileName(pageTitle, mode === 'mp3' ? 'mp3' : AMG.guessExt(it), multi ? i + 1 : 0),
      })),
    });
  }
  if (mp3Jobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'mp3', items: mp3Jobs, title: pageTitle } });
  if (hlsJobs.length) await chrome.runtime.sendMessage({ type: 'startJob', job: { type: 'hls', items: hlsJobs, title: pageTitle } });

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
