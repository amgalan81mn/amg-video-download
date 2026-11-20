// Жагсаалтын зураг дээр дарахад нээгддэг тоглуулагч.
// v = дүрсний холбоос, a = тусдаа дууны холбоос (Facebook дүрс+дуу хувилбарт), t = гарчиг
const p = new URLSearchParams(location.search);
const v = document.getElementById('v');
const a = document.getElementById('a');
const msg = document.getElementById('msg');
const audioUrl = p.get('a') || '';
if (p.get('t')) document.title = `▶ ${p.get('t')}`;

function show(text, err) {
  msg.textContent = text;
  msg.className = text ? `show${err ? ' err' : ''}` : '';
}

// ---------- Тусдаа дууг дүрстэй тааруулж тоглуулах ----------
if (audioUrl) {
  a.src = audioUrl;
  a.preload = 'auto';
  const sync = (force) => {
    if (force || Math.abs(a.currentTime - v.currentTime) > 0.25) a.currentTime = v.currentTime;
  };
  v.addEventListener('play', () => { sync(true); a.play().catch(() => {}); });
  v.addEventListener('pause', () => a.pause());
  v.addEventListener('waiting', () => a.pause());
  v.addEventListener('playing', () => { sync(true); a.play().catch(() => {}); });
  v.addEventListener('seeked', () => sync(true));
  v.addEventListener('timeupdate', () => { if (!v.paused) sync(false); });
  v.addEventListener('ratechange', () => { a.playbackRate = v.playbackRate; });
  v.addEventListener('volumechange', () => { a.volume = v.volume; a.muted = v.muted; });
  v.addEventListener('ended', () => a.pause());
}

v.addEventListener('error', () => show('Видеог тоглуулж чадсангүй (холбоосны хугацаа дууссан байж магадгүй — хуудсаа шинэчлээд дахин нээнэ үү)', true));

v.src = p.get('v') || '';
v.play().catch(() => {
  // Chrome дуутай автоматаар тоглуулахыг хориглосон бол дуугүй эхлүүлээд, дарахад дуутай болгоно
  v.muted = true;
  if (audioUrl) a.muted = true;
  v.play().catch(() => {});
  show('🔇 Дуутай болгохын тулд энд дарна уу');
  msg.addEventListener('click', () => {
    v.muted = false;
    a.muted = false;
    show('');
  }, { once: true });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
});
