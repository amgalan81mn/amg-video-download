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

  // Зөвхөн файлын нэр (хавтасгүй). Хавтсыг download() тохиргооноос нэмнэ.
  function fileName(title, ext, idx) {
    const suffix = idx ? `-${idx}` : '';
    return `${safeName(title)}${suffix}.${ext}`;
  }

  // ---------- Тохиргоо ----------
  const DEFAULT_SETTINGS = { folder: 'Amg-Video-Download', askLocation: false };

  // "Downloads" доторх дэд хавтасны замыг аюулгүй болгох
  function cleanFolder(f) {
    return String(f || '')
      .split(/[\\/]+/)
      .map((seg) => seg
        .replace(/[:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .slice(0, 60))
      .filter(Boolean)
      .join('/');
  }

  async function getSettings() {
    const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return { folder: cleanFolder(s.folder), askLocation: !!s.askLocation };
  }

  async function saveSettings(s) {
    await chrome.storage.sync.set({ folder: cleanFolder(s.folder), askLocation: !!s.askLocation });
  }

  // ---------- Давхардал шалгаж татах ----------
  function sameEnd(abs, rel) {
    const a = abs.replace(/\\/g, '/').toLowerCase();
    const r = '/' + rel.replace(/\\/g, '/').toLowerCase();
    return a.endsWith(r);
  }

  async function findExisting(relPath) {
    const base = relPath.split('/').pop();
    // search() дуудахад Chrome файл байгаа эсэхийг дахин шалгадаг
    const found = await chrome.downloads.search({ query: [base], state: 'complete', limit: 200 });
    return found.find((d) => d.exists !== false && d.filename && sameEnd(d.filename, relPath)) || null;
  }

  // Нэр давхцвал асуух цонх нээж, хариуг хүлээнэ: 'overwrite' | 'rename' | 'cancel'
  function askConflict(relPath) {
    const rid = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve) => {
      let winId = null;
      // Хэрэглэгч бодож байх хооронд background service worker унтахаас сэргийлнэ
      const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
      const finish = (ans) => {
        clearInterval(keepAlive);
        chrome.runtime.onMessage.removeListener(onMsg);
        chrome.windows.onRemoved.removeListener(onClose);
        resolve(ans);
      };
      const onMsg = (m) => {
        if (m && m.type === 'conflictAnswer' && m.rid === rid) finish(m.answer);
      };
      const onClose = (id) => { if (id === winId) finish('cancel'); };
      chrome.runtime.onMessage.addListener(onMsg);
      chrome.windows.onRemoved.addListener(onClose);
      const q = new URLSearchParams({ rid, file: relPath }).toString();
      chrome.windows.create({ url: chrome.runtime.getURL(`confirm.html?${q}`), type: 'popup', width: 440, height: 260, focused: true })
        .then((w) => { winId = w.id; });
    });
  }

  // Бүх таталт энэ функцээр дамжина. Буцаах утга: downloadId эсвэл null (цуцалсан)
  async function download(url, name) {
    const s = await getSettings();
    const rel = s.folder ? `${s.folder}/${name}` : name;
    if (s.askLocation) {
      // Chrome-ийн "Save As" цонх сүүлд сонгосон хавтсыг өөрөө санадаг
      return chrome.downloads.download({ url, filename: rel, saveAs: true });
    }
    let conflictAction = 'uniquify';
    if (await findExisting(rel)) {
      const ans = await askConflict(rel);
      if (ans === 'cancel') return null;
      conflictAction = ans === 'overwrite' ? 'overwrite' : 'uniquify';
    }
    return chrome.downloads.download({ url, filename: rel, conflictAction, saveAs: false });
  }

  // Facebook/Instagram (fbcdn) холбоосын efg параметрийг задлаж: аль видеонд хамаарах,
  // ямар чанартай, дуутай эсэхийг тодорхойлно. Мэдээлэлгүй бол {}.
  function mediaInfo(url) {
    const info = {};
    let u;
    try { u = new URL(url); } catch (e) { return info; }
    const efg = u.searchParams.get('efg');
    if (efg) {
      try {
        const j = JSON.parse(atob(efg.replace(/-/g, '+').replace(/_/g, '/')));
        if (j.vencode_tag) info.tag = String(j.vencode_tag);
        if (j.xpv_asset_id || j.video_id) info.group = `fb_${j.xpv_asset_id || j.video_id}`;
        if (j.video_id) info.videoId = String(j.video_id);
        if (j.bitrate) info.bitrate = Number(j.bitrate) || 0;
        if (j.duration_s) info.duration = Number(j.duration_s) || 0;
      } catch (e) { /* ignore */ }
    }
    const tag = info.tag || '';
    if (/audio/i.test(tag)) info.audioOnly = true;
    if (/progressive/i.test(tag)) info.hasAudio = true;
    const h = tag.match(/(\d{3,4})p\b/) || tag.match(/\.(\d{3,4})\./);
    if (h) info.height = Number(h[1]);
    return info;
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
        playing: !el.paused && !el.ended,
      };
      add(el.currentSrc || el.src, info);
      el.querySelectorAll('source').forEach((s) => add(s.src, Object.assign({}, info, { mime: s.type || '' })));
    });
    // Том хэмжээтэй зураг: srcset-ээс хамгийн томыг сонгоно. Жижиг дүрс, профайл зургийг алгасна.
    const MIN_IMG = 400;
    const imgs = [];
    document.querySelectorAll('img').forEach((im) => {
      let url = im.currentSrc || im.src;
      let w = im.naturalWidth || 0;
      let h = im.naturalHeight || 0;
      if (im.srcset) {
        im.srcset.split(',').forEach((c) => {
          const [u, d] = c.trim().split(/\s+/);
          const cw = d && /w$/.test(d) ? parseInt(d, 10) : 0;
          if (u && cw > w) {
            if (w && h) h = Math.round((h * cw) / w);
            w = cw;
            url = u;
          }
        });
      }
      if (!url || /^(data|blob):/.test(url) || Math.max(w, h) < MIN_IMG) return;
      imgs.push({ url, w, h });
    });
    imgs.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 60)
      .forEach((x) => add(x.url, { kind: 'image', width: x.w, height: x.h }));
    document.querySelectorAll('meta[property="og:image"], meta[property="og:image:url"]').forEach((m) => {
      if (m.content) add(m.content, { kind: 'image', label: 'og:image' });
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
      // Instagram: холбоос бүрийн өмнөх хамгийн ойрын "code" нь тухайн reel/пост-ын хаягийн код
      const codes = [];
      if (/(^|\.)instagram\.com$/.test(location.hostname)) {
        const cre0 = /"code"\s*:\s*"(?![a-z]{2}_[A-Z]{2}")([A-Za-z0-9_-]{8,})"/g; // en_US гэх мэтийг алгасна
        let c;
        while ((c = cre0.exec(html))) codes.push([c.index, c[1]]);
      }
      const codeAt = (pos) => {
        let lo = 0;
        let hi = codes.length - 1;
        let ans;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (codes[mid][0] < pos) { ans = codes[mid][1]; lo = mid + 1; } else hi = mid - 1;
        }
        return ans === '__none__' ? undefined : ans;
      };
      // Хуудасны HTML-ийн сүүлийн код fbcap-ийн барьсан хэсэгт (#__amg_cap) дамжихгүй байх
      const capAt = html.indexOf('id="__amg_cap"');
      if (capAt >= 0 && codes.length) codes.push([capAt, '__none__']);
      codes.sort((a, b) => a[0] - b[0]);
      // Instagram-ийн дуутай MP4 (video_versions)
      const vre = /"video_versions"\s*:\s*(\[[^\]]*\])/g;
      let vm;
      while ((vm = vre.exec(html))) {
        try {
          JSON.parse(vm[1]).forEach((v) => {
            if (v && v.url) {
              add(v.url, {
                label: 'video_versions', source: 'json', width: v.width || 0, height: v.height || 0, igCode: codeAt(vm.index),
              });
            }
          });
        } catch (e) { /* ignore */ }
      }
      const re = /"(browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|progressive_url|video_url|contentUrl|hd_src|sd_src)"\s*:\s*"(https?:[^"]+)"/g;
      let m;
      let count = 0;
      while ((m = re.exec(html)) && count < 400) {
        let u = m[2];
        try { u = JSON.parse('"' + u + '"'); } catch (e) { u = u.replace(/\\\//g, '/'); }
        u = u.replace(/&amp;/g, '&');
        add(u, { label: m[1], source: 'json', igCode: codeAt(m.index) });
        count++;
      }
      // DASH manifest доторх <BaseURL> (дүрс тус бүрийн чанар, тусдаа дуу). Хуудасны HTML болон
      // reels гүйлгэхэд fbcap.js-ийн барьж авсан GraphQL хариу (#__amg_cap) хоёуланд байна.
      // Эхлээд <Representation>-ий шинжтэй хамт: кодек (av01/vp09/avc1), өргөн, өндөр, чанарын нэр.
      // "q90" гэх мэт кодлолын нэр видео бүрт өөр нягтралтай байдаг тул холбоостой нь хамт авна.
      const cre = /codecs=\\?"([^"\\]+)\\?"[^>]*?FBEncodingTag=\\?"([^"\\]+)\\?"[^>]*?width=\\?"(\d+)\\?"\s+height=\\?"(\d+)\\?"[^>]*?FBQualityLabel=\\?"([^"\\]+)\\?"[^>]*>[\s\S]{0,3000}?BaseURL(?:>|&gt;)(https?:(?:\\\/|[^\\<"\s])+)/g;
      count = 0;
      while ((m = cre.exec(html)) && count < 1500) {
        const u = m[6].replace(/\\\//g, '/').replace(/&amp;/g, '&');
        // FBContentLength байвал файлын хэмжээ
        const len = (m[0].match(/FBContentLength=\\?"(\d+)/) || [])[1];
        add(u, {
          label: 'dash', source: 'json', codecs: m[1], width: Number(m[3]), height: Number(m[4]), quality: m[5],
          size: len ? Number(len) : 0, igCode: codeAt(m.index),
        });
        count++;
      }
      // Үлдсэн нь (тусдаа дуу гэх мэт)
      const bre = /BaseURL(?:>|&gt;)(https?:(?:\\\/|[^\\<"\s])+)/g;
      count = 0;
      while ((m = bre.exec(html)) && count < 1500) {
        const u = m[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
        add(u, { label: 'dash', source: 'json', igCode: codeAt(m.index) });
        count++;
      }
    } catch (e) { /* ignore */ }
    // Facebook-ийн DASH жагсаалтаас: кодлолын нэр → чанар (720p гэх мэт), өргөн, өндөр
    const reps = {};
    try {
      const html = document.documentElement.innerHTML;
      const rre = /FBEncodingTag=\\?"([^"\\]+)\\?"[^>]*?width=\\?"(\d+)\\?"\s+height=\\?"(\d+)\\?"[^>]*?FBQualityLabel=\\?"([^"\\]+)\\?"/g;
      let m;
      let count = 0;
      while ((m = rre.exec(html)) && count < 3000) {
        reps[m[1]] = { width: Number(m[2]), height: Number(m[3]), quality: m[4] };
        count++;
      }
    } catch (e) { /* ignore */ }
    return { title: document.title, url: location.href, items: out, reps };
  }

  return {
    classify, cleanUrl, guessExt, fileName, safeName, humanSize, scanPage, extOf, mediaInfo,
    DEFAULT_SETTINGS, cleanFolder, getSettings, saveSettings, download,
  };
})();

if (typeof self !== 'undefined') self.AMG = AMG;
