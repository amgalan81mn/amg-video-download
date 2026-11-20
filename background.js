/* global AMG */
importScripts('common.js');

const KEY = (tabId) => `sniff_${tabId}`;
const MAX_PER_TAB = 150;

// ---------- Сүлжээгээр дамжиж буй медиаг барих ----------
async function getSniffed(tabId) {
  const k = KEY(tabId);
  const r = await chrome.storage.session.get(k);
  return r[k] || [];
}

async function setSniffed(tabId, list) {
  await chrome.storage.session.set({ [KEY(tabId)]: list });
  const n = list.filter((i) => i.kind !== 'blob').length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {});
}

// service worker унтахаас сэргийлж нэг табын бичилтийг дараалуулна
const queues = new Map();
function enqueue(tabId, fn) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  queues.set(tabId, next);
  return next;
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.method !== 'GET') return;
    if (d.statusCode && d.statusCode >= 400) return;
    const mime = header(d.responseHeaders, 'content-type');
    const kind = AMG.classify(d.url, mime);
    if (!kind || kind === 'blob') return;
    // HLS-ийн жижиг хэсгүүдийг (.ts, .m4s) жагсаалтад оруулахгүй
    if (/\.(ts|m4s)(\?|$)/i.test(d.url)) return;

    let size = 0;
    const cr = header(d.responseHeaders, 'content-range');
    const crm = cr.match(/\/(\d+)\s*$/);
    if (crm) size = Number(crm[1]);
    else size = Number(header(d.responseHeaders, 'content-length')) || 0;
    if (!crm && size && size < 30 * 1024 && kind !== 'hls' && kind !== 'dash') return; // хэт жижиг

    const url = AMG.cleanUrl(d.url);
    enqueue(d.tabId, async () => {
      const list = await getSniffed(d.tabId);
      const existing = list.find((i) => i.url === url);
      if (existing) {
        if (size > (existing.size || 0)) existing.size = size;
      } else {
        list.unshift({ url, kind, mime: mime.split(';')[0], size, source: 'network', time: Date.now() });
        if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
      }
      await setSniffed(d.tabId, list);
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    enqueue(tabId, () => setSniffed(tabId, []));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(KEY(tabId));
  queues.delete(tabId);
});

// ---------- Баруун товчны цэс ----------
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'amg-root', title: 'Amg-Video-Download', contexts: ['all'] });
    chrome.contextMenus.create({
      id: 'amg-media', parentId: 'amg-root', title: 'Энэ видео/аудиог татах (MP4)', contexts: ['video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'amg-media-mp3', parentId: 'amg-root', title: 'MP3 болгож татах', contexts: ['video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'amg-link', parentId: 'amg-root', title: 'Энэ линкнээс медиа хайж татах', contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'amg-page', parentId: 'amg-root', title: 'Энэ хуудсан дээрх бүх медиаг харах / сонгох', contexts: ['all'],
    });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

function openPicker(params) {
  const q = new URLSearchParams(params).toString();
  chrome.windows.create({
    url: chrome.runtime.getURL(`popup.html?${q}`),
    type: 'popup',
    width: 520,
    height: 680,
  });
}

async function startJob(job) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await chrome.storage.session.set({ [id]: job });
  chrome.windows.create({
    url: chrome.runtime.getURL(`job.html?id=${id}`),
    type: 'popup',
    width: 460,
    height: 360,
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab ? tab.id : -1;
  const title = (tab && tab.title) || 'amg-video';

  if (info.menuItemId === 'amg-media' || info.menuItemId === 'amg-media-mp3') {
    const src = info.srcUrl || '';
    const kind = AMG.classify(src, '') || 'video';
    if (!src || src.startsWith('blob:') || kind === 'hls' || kind === 'dash') {
      // blob: (YouTube, Facebook, Instagram) — шууд татах боломжгүй тул сонголтын цонх нээнэ
      openPicker({ tab: tabId, mode: info.menuItemId === 'amg-media-mp3' ? 'mp3' : 'orig' });
      return;
    }
    const item = { url: src, kind, mime: '' };
    if (info.menuItemId === 'amg-media-mp3') {
      startJob({ type: 'mp3', items: [item], title });
    } else {
      AMG.download(src, AMG.fileName(title, AMG.guessExt(item)));
    }
    return;
  }
  if (info.menuItemId === 'amg-link') {
    openPicker({ url: info.linkUrl });
    return;
  }
  if (info.menuItemId === 'amg-page') {
    openPicker({ tab: tabId });
  }
});

// ---------- Popup-аас ирэх хүсэлтүүд ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'startJob') {
    startJob(msg.job).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === 'download') {
    // Popup хаагдсан ч таталт үргэлжлэхийн тулд background хийнэ (нэг нэгээр нь)
    (async () => {
      for (const d of msg.items) {
        try { await AMG.download(d.url, d.name); } catch (e) { notifyError(d.name, e.message); }
      }
    })();
    reply({ ok: true });
    return false;
  }
  if (msg.type === 'getSniffed') {
    getSniffed(msg.tabId).then((list) => reply(list));
    return true;
  }
  return false;
});

// ---------- Хадгалсны дараах мэдэгдэл (видео дүрстэй) ----------
function notifyError(name, reason) {
  chrome.notifications.create(`err_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/video128.png',
    title: 'Татаж чадсангүй',
    message: `${name || ''}\n${reason || ''}`.trim(),
    priority: 1,
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const [d] = await chrome.downloads.search({ id: delta.id });
  if (!d || d.byExtensionId !== chrome.runtime.id) return;
  const name = (d.filename || '').split(/[\\/]/).pop();
  if (delta.state.current === 'complete') {
    chrome.notifications.create(`dl_${d.id}`, {
      type: 'basic',
      iconUrl: 'icons/video128.png',
      title: 'Хадгаллаа ✓',
      message: name,
      contextMessage: d.filename,
      buttons: [{ title: 'Хавтсанд харах' }, { title: 'Нээх' }],
      priority: 1,
    });
  } else if (delta.state.current === 'interrupted' && d.error !== 'USER_CANCELED') {
    notifyError(name, `Алдаа: ${d.error || 'тодорхойгүй'}`);
  }
});

function dlIdOf(notifId) {
  return notifId.startsWith('dl_') ? Number(notifId.slice(3)) : null;
}
chrome.notifications.onClicked.addListener((nid) => {
  const id = dlIdOf(nid);
  if (id != null) chrome.downloads.show(id);
  chrome.notifications.clear(nid);
});
chrome.notifications.onButtonClicked.addListener((nid, btn) => {
  const id = dlIdOf(nid);
  if (id == null) return;
  if (btn === 0) chrome.downloads.show(id);
  else chrome.downloads.open(id);
  chrome.notifications.clear(nid);
});
