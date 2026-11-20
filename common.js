// Amg-Video-Download — background, popup, job хуудсууд хамтдаа хэрэглэдэг функцууд
/* exported AMG */
const AMG = (() => {
  const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'flv', '3gp', 'avi'];
  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
  const HLS_EXT = ['m3u8'];
  const DASH_EXT = ['mpd'];

  function extOf(url) {
    try {
      const p = new URL(url).pathname.toLowerCase();
      const m = p.match(/\.([a-z0-9]{2,5})$/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  // Хэсэгчилсэн (range) хүсэлтийн параметрийг авч бүтэн файлын холбоос болгоно
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      ['bytestart', 'byteend', 'range', 'rn', 'rbuf'].forEach((k) => u.searchParams.delete(k));
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // Холбоос + content-type-ээс медиа төрөл тодорхойлох. Медиа биш бол null.
  function classify(url, mime) {
    mime = (mime || '').toLowerCase().split(';')[0].trim();
    if (!url || url.startsWith('data:')) return null;
    if (url.startsWith('blob:')) return 'blob';
    let qmime = '';
    try {
      qmime = (new URL(url).searchParams.get('mime') || '').toLowerCase();
    } catch (e) { /* ignore */ }
    const m = mime || qmime;
    if (m.includes('mpegurl')) return 'hls';
    if (m.includes('dash+xml')) return 'dash';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    const ext = extOf(url);
    if (HLS_EXT.includes(ext)) return 'hls';
    if (DASH_EXT.includes(ext)) return 'dash';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    return null;
  }

  function guessExt(item) {
    const ext = extOf(item.url);
    if (ext && ext !== 'm3u8' && ext !== 'mpd') return ext;
    const m = (item.mime || '').toLowerCase();
    if (m.includes('webm')) return item.kind === 'audio' ? 'weba' : 'webm';
    if (m.includes('mpeg') && item.kind === 'audio') return 'mp3';
    if (item.kind === 'audio') return 'm4a';
    return 'mp4';
  }

  function safeName(s, max = 80) {
    return (s || 'amg-video')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, max) || 'amg-video';
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function fileName(title, ext, idx) {
    const suffix = idx ? `-${idx}` : '';
    return `Amg-Video-Download/${safeName(title)}-${stamp()}${suffix}.${ext}`;
  }

  function humanSize(n) {
    if (!n || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  // Хуудсан дотор ажиллана (chrome.scripting.executeScript-ээр оруулна) — бие даасан байх ёстой
  function scanPage() {
    const out = [];
    const seen = new Set();
    const add = (url, extra) => {
      if (!url) return;
      try { url = new URL(url, location.href).toString(); } catch (e) { return; }
      if (seen.has(url)) return;
      seen.add(url);
      out.push(Object.assign({ url, source: 'dom' }, extra));
    };
    document.querySelectorAll('video, audio').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const info = {
        tag,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        duration: isFinite(el.duration) ? el.duration : 0,
      };
      add(el.currentSrc || el.src, info);
      el.querySelectorAll('source').forEach((s) => add(s.src, Object.assign({}, info, { mime: s.type || '' })));
    });
    const metaKeys = ['og:video', 'og:video:url', 'og:video:secure_url', 'og:audio', 'og:audio:url',
      'og:audio:secure_url', 'twitter:player:stream'];
    document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
      const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (metaKeys.includes(k)) add(m.content, { label: k });
    });
    const mediaRe = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|aac|ogg|opus|wav|flac|m3u8)(\?|#|$)/i;
    document.querySelectorAll('a[href]').forEach((a) => {
      if (mediaRe.test(a.href)) add(a.href, { label: (a.textContent || '').trim().slice(0, 60) });
    });
    // Facebook / Instagram гэх мэт хуудасны JSON өгөгдөл дотроос шууд холбоос хайх
    try {
      const html = document.documentElement.innerHTML;
      const re = /"(browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|video_url|contentUrl|hd_src|sd_src)"\s*:\s*"(https?:[^"]+)"/g;
      let m;
      let count = 0;
      while ((m = re.exec(html)) && count < 60) {
        let u = m[2];
        try { u = JSON.parse('"' + u + '"'); } catch (e) { u = u.replace(/\\\//g, '/'); }
        u = u.replace(/&amp;/g, '&');
        add(u, { label: m[1], source: 'json' });
        count++;
      }
    } catch (e) { /* ignore */ }
    return { title: document.title, url: location.href, items: out };
  }

  return { classify, cleanUrl, guessExt, fileName, safeName, humanSize, scanPage, extOf };
})();

if (typeof self !== 'undefined') self.AMG = AMG;
