// Amg-Video-Download — Facebook / Instagram хуудасны MAIN world-д document_start үед ажиллана.
// Reels-ийг гүйлгэхэд дараагийн видеонуудын холбоос (DASH manifest, progressive_url) GraphQL
// хариугаар ирдэг бөгөөд хуудасны HTML-д байдаггүй. Тэр хариунаас хэрэгтэй хэсгийг нь салгаж
// <script id="__amg_cap" type="application/json"> элементэд хадгална. Popup-ын scanPage түүнийг уншина.
(() => {
  if (window.__amgCapInstalled) return;
  window.__amgCapInstalled = true;

  const MAX_CHARS = 4000000; // хэт их санах ой эзлэхээс сэргийлнэ (хуучнаас нь хасна)
  const WANT = /manifest_xml|video_dash_manifest|progressive_url|playable_url|browser_native_/;
  const PICK = [
    /"(?:manifest_xml|video_dash_manifest)"\s*:\s*"(?:[^"\\]|\\.)*"/g,
    /"(?:progressive_url|playable_url[a-z_]*|browser_native_[a-z_]*url)"\s*:\s*"(?:[^"\\]|\\.)*"/g,
  ];
  const chunks = [];
  let total = 0;
  let el = null;

  function keep(text) {
    if (typeof text !== 'string' || text.length < 200 || !WANT.test(text)) return;
    const parts = [];
    PICK.forEach((re) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) parts.push(m[0]);
    });
    if (!parts.length) return;
    const chunk = parts.join('\n');
    chunks.push(chunk);
    total += chunk.length;
    while (total > MAX_CHARS && chunks.length > 1) total -= chunks.shift().length;
    try {
      if (!el || !el.isConnected) {
        el = document.createElement('script');
        el.type = 'application/json';
        el.id = '__amg_cap';
        document.documentElement.appendChild(el);
      }
      el.textContent = chunks.join('\n');
    } catch (e) { /* ignore */ }
  }

  const isApi = (u) => /graphql|\/api\/|\/ajax\//i.test(String(u || ''));

  // XMLHttpRequest (Facebook GraphQL)
  try {
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function open(method, url) {
      this.__amgUrl = url;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function send() {
      if (isApi(this.__amgUrl)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') keep(this.responseText);
          } catch (e) { /* ignore */ }
        });
      }
      return XS.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  // fetch (Instagram, Facebook-ийн зарим хүсэлт)
  try {
    const F = window.fetch;
    window.fetch = function fetch(input) {
      const p = F.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url);
        if (isApi(url)) {
          p.then((r) => {
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (/json|javascript|text/.test(ct) || !ct) r.clone().text().then(keep).catch(() => {});
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  } catch (e) { /* ignore */ }
})();
