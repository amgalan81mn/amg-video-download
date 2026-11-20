// Amg-Video-Download — дуугүй дүрс + тусдаа дуу (fragmented MP4, Facebook DASH) хоёрыг
// нэг MP4 болгож нийлүүлнэ. Дахин кодлохгүй, зөвхөн хайрцгуудыг (box) нь нэгтгэнэ.
/* exported AMG_MUX */
const AMG_MUX = (() => {
  const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

  function boxes(b, s, e) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = [];
    let p = s;
    while (p + 8 <= e) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = e - p;
      if (size < hdr || p + size > e) break;
      out.push({ type: fourcc(b, p + 4), start: p, size, hdr });
      p += size;
    }
    return out;
  }
  const kids = (b, box) => boxes(b, box.start + box.hdr, box.start + box.size);
  const find = (list, t) => list.find((x) => x.type === t);
  const copy = (b, box) => b.slice(box.start, box.start + box.size);

  function concat(parts) {
    let len = 0;
    parts.forEach((p) => { len += p.length; });
    const out = new Uint8Array(len);
    let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }
  function makeBox(type, parts) {
    const body = concat(parts);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }

  // Хувилбар (version) 0 бол 32 бит, 1 бол 64 бит талбар
  const rd = (dv, off, wide) => (wide ? Number(dv.getBigUint64(off)) : dv.getUint32(off));
  const wr = (dv, off, wide, v) => {
    if (wide) dv.setBigUint64(off, BigInt(Math.round(v)));
    else dv.setUint32(off, Math.min(0xffffffff, Math.round(v)));
  };

  // mvhd / mdhd: timescale, duration
  function hdTimes(buf, rel) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const v1 = buf[rel] === 1;
    const tsOff = rel + (v1 ? 20 : 12);
    return { dv, v1, tsOff, durOff: tsOff + 4, timescale: dv.getUint32(tsOff), duration: rd(dv, tsOff + 4, v1) };
  }

  function parse(b, label) {
    const top = boxes(b, 0, b.length);
    const moov = find(top, 'moov');
    if (!moov) throw new Error(`${label}: moov хайрцаг олдсонгүй`);
    const mk = kids(b, moov);
    const mvex = find(mk, 'mvex');
    if (!mvex) throw new Error(`${label}: fragmented MP4 биш тул нийлүүлэх боломжгүй`);
    const traks = mk.filter((x) => x.type === 'trak');
    if (traks.length !== 1) throw new Error(`${label}: нэг track байх ёстой (${traks.length})`);
    const trak = traks[0];
    const tk = kids(b, trak);
    const tkhd = find(tk, 'tkhd');
    const mdia = find(tk, 'mdia');
    const mdhd = mdia && find(kids(b, mdia), 'mdhd');
    const mvhd = find(mk, 'mvhd');
    const mx = kids(b, mvex);
    const trex = find(mx, 'trex');
    if (!tkhd || !mdhd || !mvhd || !trex) throw new Error(`${label}: MP4 бүтэц дутуу`);

    const mediaTs = hdTimes(b, mdhd.start + mdhd.hdr).timescale || 1;
    const frags = [];
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== 'moof') continue;
      const mdat = top[i + 1];
      if (!mdat || mdat.type !== 'mdat') throw new Error(`${label}: moof-ийн ард mdat алга`);
      const trafs = kids(b, top[i]).filter((x) => x.type === 'traf');
      let t = 0;
      trafs.forEach((traf, ti) => {
        const tc = kids(b, traf);
        const tfhd = find(tc, 'tfhd');
        // base-data-offset-present: үнэмлэхүй байрлал заадаг тул зөөж болохгүй
        if (tfhd && (new DataView(b.buffer, b.byteOffset).getUint32(tfhd.start + tfhd.hdr) & 0x1)) {
          throw new Error(`${label}: дэмжигдээгүй MP4 (base-data-offset)`);
        }
        const tfdt = find(tc, 'tfdt');
        if (ti === 0 && tfdt) {
          const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
          t = rd(dv, tfdt.start + tfdt.hdr + 4, b[tfdt.start + tfdt.hdr] === 1) / mediaTs;
        }
      });
      frags.push({ moof: top[i], mdat, t });
      i++;
    }
    if (!frags.length) throw new Error(`${label}: фрагмент олдсонгүй`);
    return { b, top, mk, mvhd, mvex, mx, trak, tkhd, trex, frags };
  }

  // tkhd дотор track_ID болон duration-ийн байрлал (хайрцгийн эхнээс)
  function tkhdOffsets(buf, rel) {
    const v1 = buf[rel] === 1;
    const idOff = rel + (v1 ? 20 : 12);
    return { v1, idOff, durOff: idOff + 8 };
  }

  function setTrackIdInMoof(moofCopy, newId) {
    boxes(moofCopy, 8, moofCopy.length).filter((x) => x.type === 'traf').forEach((traf) => {
      const tfhd = find(kids(moofCopy, traf), 'tfhd');
      if (tfhd) new DataView(moofCopy.buffer).setUint32(tfhd.start + tfhd.hdr + 4, newId);
    });
  }

  // videoBuf, audioBuf: ArrayBuffer | Uint8Array. Буцаах: Uint8Array (MP4)
  function merge(videoBuf, audioBuf) {
    const V = parse(new Uint8Array(videoBuf), 'Дүрс');
    const A = parse(new Uint8Array(audioBuf), 'Дуу');

    // Track ID: дүрс хэвээр, дуу = дүрс + 1
    const vT = tkhdOffsets(V.b, V.tkhd.start + V.tkhd.hdr);
    const vId = new DataView(V.b.buffer, V.b.byteOffset).getUint32(vT.idOff);
    const aId = vId + 1;

    // Киноны хугацаа (дүрсний mvhd timescale-ээр)
    const vMv = hdTimes(V.b, V.mvhd.start + V.mvhd.hdr);
    const aMv = hdTimes(A.b, A.mvhd.start + A.mvhd.hdr);
    const MT = vMv.timescale || 1000;
    // Facebook-ийн файлд mvhd-ийн хугацаа 0 байдаг тул mehd-ээс (fragment-ийн нийт хугацаа) авна
    const mehdDur = (P) => {
      const m = find(P.mx, 'mehd');
      if (!m) return 0;
      const dv = new DataView(P.b.buffer, P.b.byteOffset, P.b.byteLength);
      return rd(dv, m.start + m.hdr + 4, P.b[m.start + m.hdr] === 1);
    };
    const vDur = Math.max(vMv.duration, mehdDur(V));
    const aRaw = Math.max(aMv.duration, mehdDur(A));
    const aDur = aMv.timescale ? (aRaw * MT) / aMv.timescale : 0;
    const dur = Math.max(vDur, aDur);
    // Дүрсний tkhd-д хугацаа 0 бол мөн нөхнө
    const fixTkhd = (trakCopy, P) => {
      const o = tkhdOffsets(trakCopy, P.tkhd.start - P.trak.start + P.tkhd.hdr);
      const dv = new DataView(trakCopy.buffer);
      if (!rd(dv, o.durOff, o.v1)) wr(dv, o.durOff, o.v1, P === V ? vDur : aDur);
    };

    const mvhd = copy(V.b, V.mvhd);
    const mh = hdTimes(mvhd, V.mvhd.hdr);
    wr(mh.dv, mh.durOff, mh.v1, dur);
    mh.dv.setUint32(mvhd.length - 4, aId + 1); // next_track_ID

    const vTrak = copy(V.b, V.trak);
    const aTrak = copy(A.b, A.trak);
    const aT = tkhdOffsets(aTrak, A.tkhd.start - A.trak.start + A.tkhd.hdr);
    const aTv = new DataView(aTrak.buffer);
    aTv.setUint32(aT.idOff, aId);
    wr(aTv, aT.durOff, aT.v1, aDur);
    fixTkhd(vTrak, V);

    const mvexParts = [];
    const mehd = find(V.mx, 'mehd');
    if (mehd) {
      const m = copy(V.b, mehd);
      wr(new DataView(m.buffer), mehd.hdr + 4, m[mehd.hdr] === 1, dur);
      mvexParts.push(m);
    }
    mvexParts.push(copy(V.b, V.trex));
    const aTrex = copy(A.b, A.trex);
    new DataView(aTrex.buffer).setUint32(A.trex.hdr + 4, aId);
    mvexParts.push(aTrex);

    // moov: mvhd, (meta, udta ...), trak дүрс, trak дуу, mvex
    const extra = V.mk.filter((x) => !['mvhd', 'trak', 'mvex'].includes(x.type)).map((x) => copy(V.b, x));
    const moov = makeBox('moov', [mvhd, ...extra, vTrak, aTrak, makeBox('mvex', mvexParts)]);

    // Түгээмэл тоглуулагчид таних ftyp
    const ftyp = makeBox('ftyp', [new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0,
      105, 115, 111, 109, 105, 115, 111, 54, 105, 115, 111, 50, 109, 112, 52, 49])]); // isom 512: isom iso6 iso2 mp41

    // Фрагментуудыг цаг хугацааны дарааллаар холино
    const all = V.frags.map((f) => ({ f, src: V, audio: false }))
      .concat(A.frags.map((f) => ({ f, src: A, audio: true })))
      .sort((x, y) => (x.f.t - y.f.t) || (x.audio - y.audio));
    const parts = [ftyp, moov];
    all.forEach((e, i) => {
      const moof = copy(e.src.b, e.f.moof);
      const mfhd = find(boxes(moof, 8, moof.length), 'mfhd');
      if (mfhd) new DataView(moof.buffer).setUint32(mfhd.start + mfhd.hdr + 4, i + 1);
      if (e.audio) setTrackIdInMoof(moof, aId);
      parts.push(moof, e.src.b.subarray(e.f.mdat.start, e.f.mdat.start + e.f.mdat.size));
    });
    return concat(parts);
  }

  return { merge };
})();

if (typeof self !== 'undefined') self.AMG_MUX = AMG_MUX;
