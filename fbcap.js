// Amg-Video-Download — Facebook / Instagram хуудасны MAIN world-д document_start үед ажиллана.
// Reels-ийг гүйлгэхэд дараагийн видеонуудын холбоос (DASH manifest, progressive_url) GraphQL
// хариугаар ирдэг бөгөөд хуудасны HTML-д байдаггүй. Тэр хариунаас хэрэгтэй хэсгийг нь салгаж
// <script id="__amg_cap" type="application/json"> элементэд хадгална. Popup-ын scanPage түүнийг уншина.
(() => {
  if (window.__amgCapInstalled) return;
  window.__amgCapInstalled = true;

  const MAX_CHARS = 4000000; // хэт их санах ой эзлэхээс сэргийлнэ (хуучнаас нь хасна)
  const WANT = /manifest_xml|video_dash_manifest|video_versions|progressive_url|playable_url|browser_native_/;
  const PICK = [
    /"(?:manifest_xml|video_dash_manifest)"\s*:\s*"(?:[^"\\]|\\.)*"/g,
    /"(?:progressive_url|playable_url[a-z_]*|browser_native_[a-z_]*url)"\s*:\s*"(?:[^"\\]|\\.)*"/g,
    /"video_versions"\s*:\s*\[[^\]]*\]/g, // Instagram: дуутай MP4 хувилбарууд
  ];
  // Instagram: медиа бүрийн "code" (хаягт байдаг Df7dtW_R9X6 гэх мэт) нь түүний видеоноос өмнө ирдэг.
  // Видеоны хэсэг бүрийн өмнө хамгийн ойрын code-ийг нэмж бичнэ, ингэвэл scanPage тааруулж чадна.
  const CODE_RE = /"code"\s*:\s*"(?![a-z]{2}_[A-Z]{2}")([A-Za-z0-9_-]{8,})"/g; // en_US гэх мэтийг алгасна
  const chunks = [];
  let total = 0;
  let el = null;

  function keep(text) {
    if (typeof text !== 'string' || text.length < 200 || !WANT.test(text)) return;
    const codes = [];
    CODE_RE.lastIndex = 0;
    let c;
    while ((c = CODE_RE.exec(text))) codes.push([c.index, c[1]]);
    const codeBefore = (pos) => {
      let lo = 0;
      let hi = codes.length - 1;
      let ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (codes[mid][0] < pos) { ans = codes[mid][1]; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };
    const found = [];
    PICK.forEach((re) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) found.push([m.index, m[0]]);
    });
    if (!found.length) return;
    found.sort((a, b) => a[0] - b[0]);
    // Хариу бүрийн эхэнд "код алга" тэмдэг: өмнөх хариуны код энэ хариунд дамжихгүй
    const parts = ['"code":"__none__"'];
    let lastCode = null;
    found.forEach(([pos, frag]) => {
      const code = codes.length ? codeBefore(pos) : null;
      if (code && code !== lastCode) { parts.push(`"code":"${code}"`); lastCode = code; }
      parts.push(frag);
    });
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
