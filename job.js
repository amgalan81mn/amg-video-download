/* global AMG, lamejs */
const main = document.getElementById('main');
const id = new URLSearchParams(location.search).get('id');

function makeRow(label) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = '<div class="name"></div><div class="small step">Хүлээж байна…</div><div class="bar"><div></div></div>';
  el.querySelector('.name').textContent = label;
  main.append(el);
  return {
    step: (t) => { el.querySelector('.step').textContent = t; },
    pct: (p) => { el.querySelector('.bar > div').style.width = `${Math.max(0, Math.min(100, p))}%`; },
    fail: (t) => { el.querySelector('.step').textContent = `Алдаа: ${t}`; el.querySelector('.step').style.color = '#b91c1c'; },
  };
}

// Явцыг харуулан татаж ArrayBuffer болгох
async function fetchWithProgress(url, onPct) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) {
    const b = await r.arrayBuffer();
    onPct(100);
    return b;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onPct((got / total) * 100);
  }
  const out = new Uint8Array(got);
  let off = 0;
  chunks.forEach((c) => { out.set(c, off); off += c.length; });
  return out.buffer;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename }, (dlId) => {
      const listener = (d) => {
        if (d.id === dlId && d.state && d.state.current !== 'in_progress') {
          chrome.downloads.onChanged.removeListener(listener);
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          resolve();
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

// ---------- Видео/аудиог MP3 болгох ----------
async function toMp3(item, filename, row) {
  row.step('Татаж байна…');
  const buf = await fetchWithProgress(item.url, (p) => row.pct(p * 0.5));

  row.step('Аудиог задалж байна…');
  const ctx = new AudioContext();
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf);
  } catch (e) {
    throw new Error('Энэ файлаас аудио уншиж чадсангүй (дуугүй видео эсвэл дэмжигдээгүй формат байж магадгүй).');
  } finally {
    ctx.close();
  }

  row.step('MP3 болгож байна…');
  const channels = Math.min(2, audio.numberOfChannels);
  const rate = audio.sampleRate;
  const enc = new lamejs.Mp3Encoder(channels, rate, 192);
  const toInt16 = (f32) => {
    const o = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return o;
  };
  const left = toInt16(audio.getChannelData(0));
  const right = channels > 1 ? toInt16(audio.getChannelData(1)) : null;
  const parts = [];
  const block = 1152;
  const step = block * 200;
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const mp3 = right ? enc.encodeBuffer(l, right.subarray(i, i + block)) : enc.encodeBuffer(l);
    if (mp3.length) parts.push(new Uint8Array(mp3));
    if (i % step === 0) {
      row.pct(50 + (i / left.length) * 50);
      await sleep0(); // цонх гацахгүй байх
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  row.pct(100);
  row.step('Хадгалж байна…');
  await saveBlob(new Blob(parts, { type: 'audio/mpeg' }), filename);
  row.step('Дууслаа ✓');
}

// ---------- HLS (m3u8) урсгалыг нэг файл болгох ----------
function parseAttrs(line) {
  const out = {};
  line.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { out[k] = v.replace(/^"|"$/g, ''); });
  return out;
}

async function hlsDownload(item, title, idx, row) {
  row.step('Жагсаалт уншиж байна…');
  let url = item.url;
  let text = await (await fetch(url, { credentials: 'include' })).text();

  if (text.includes('#EXT-X-STREAM-INF')) {
    // Хамгийн өндөр чанарыг сонгоно
    const lines = text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = Number(parseAttrs(lines[i]).BANDWIDTH) || 0;
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
        if (lines[j] && (!best || bw > best.bw)) best = { bw, uri: lines[j].trim() };
      }
    }
    if (!best) throw new Error('Чанарын жагсаалт хоосон байна.');
    url = new URL(best.uri, url).toString();
    text = await (await fetch(url, { credentials: 'include' })).text();
  }

  const keyLine = text.split(/\r?\n/).find((l) => l.startsWith('#EXT-X-KEY'));
  if (keyLine && !/METHOD=NONE/.test(keyLine)) {
    throw new Error('Энэ урсгал шифрлэгдсэн (DRM/AES) тул татах боломжгүй.');
  }

  const segs = [];
  let init = null;
  text.split(/\r?\n/).forEach((l) => {
    l = l.trim();
    if (!l) return;
    if (l.startsWith('#EXT-X-MAP')) {
      const a = parseAttrs(l);
      if (a.URI) init = new URL(a.URI, url).toString();
    } else if (!l.startsWith('#')) {
      segs.push(new URL(l, url).toString());
    }
  });
  if (!segs.length) throw new Error('Хэсэг олдсонгүй.');
  if (text.includes('#EXT-X-ENDLIST') === false) {
    row.step('Шууд дамжуулалт байна — одоогийн хэсгүүдийг л татна…');
  }

  const parts = [];
  if (init) parts.push(new Uint8Array(await (await fetch(init, { credentials: 'include' })).arrayBuffer()));
  for (let i = 0; i < segs.length; i++) {
    row.step(`Хэсэг ${i + 1} / ${segs.length} татаж байна…`);
    let ok = false;
    for (let tries = 0; tries < 3 && !ok; tries++) {
      try {
        const r = await fetch(segs[i], { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        parts.push(new Uint8Array(await r.arrayBuffer()));
        ok = true;
      } catch (e) {
        if (tries === 2) throw new Error(`${i + 1}-р хэсэг татагдсангүй (${e.message})`);
      }
    }
    row.pct(((i + 1) / segs.length) * 100);
  }
  const ext = init ? 'mp4' : 'ts';
  row.step('Хадгалж байна…');
  await saveBlob(new Blob(parts, { type: init ? 'video/mp4' : 'video/mp2t' }), AMG.fileName(title, ext, idx));
  row.step(`Дууслаа ✓ (.${ext} — VLC, Windows Media, MPC зэрэгт тоглоно)`);
}

(async () => {
  const r = await chrome.storage.session.get(id);
  const job = r[id];
  if (!job) {
    main.textContent = 'Ажил олдсонгүй.';
    return;
  }
  chrome.storage.session.remove(id);
  document.title = `Amg-Video-Download — ${job.type === 'mp3' ? 'MP3 болгож байна' : 'HLS татаж байна'}`;
  const multi = job.items.length > 1;
  let okCount = 0;
  for (let i = 0; i < job.items.length; i++) {
    const it = job.items[i];
    const label = `${i + 1}. ${job.type === 'mp3' ? 'MP3' : 'HLS'} — ${AMG.safeName(job.title, 60)}`;
    const row = makeRow(label);
    try {
      if (job.type === 'mp3') await toMp3(it, AMG.fileName(job.title, 'mp3', multi ? i + 1 : 0), row);
      else await hlsDownload(it, job.title, multi ? i + 1 : 0, row);
      okCount++;
    } catch (e) {
      row.fail(e.message || String(e));
    }
  }
  const done = document.createElement('p');
  done.className = 'small';
  done.textContent = `${okCount}/${job.items.length} амжилттай. Файлууд "Downloads/Amg-Video-Download" хавтсанд хадгалагдлаа.`;
  main.append(done);
  if (okCount === job.items.length) setTimeout(() => window.close(), 4000);
})();
