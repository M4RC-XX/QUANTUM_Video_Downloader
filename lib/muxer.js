// ISO-BMFF (Standard MP4 & fMP4) + MPEG-TS + ADTS Remuxer / Combiner
// Erzeugt aus getrennten oder kombinierten Video- und Audiospuren (fMP4, DASH, HLS TS, ADTS AAC)
// eine standardkonforme, nicht-fragmentierte MP4-Datei (ftyp + moov + mdat), die in VLC,
// Windows Media Player, QuickTime und allen Browsern zuverlässig mit Bild & Ton abspielt.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('ascii');

function readFourCC(u8, offset) {
  return textDecoder.decode(u8.subarray(offset, offset + 4));
}

export function parseBoxes(u8, start = 0, end = u8.byteLength) {
  const boxes = [];
  if (!u8 || end > u8.byteLength) end = u8 ? u8.byteLength : 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = readFourCC(u8, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      const hi = dv.getUint32(pos + 8);
      const lo = dv.getUint32(pos + 12);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    boxes.push({
      type,
      start: pos,
      end: pos + size,
      size,
      headerSize,
      dataStart: pos + headerSize,
    });
    pos += size;
  }
  return boxes;
}

function makeBox(type, ...payloads) {
  let totalPayload = 0;
  for (const p of payloads) {
    if (p) totalPayload += p.byteLength;
  }
  const out = new Uint8Array(8 + totalPayload);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 8 + totalPayload);
  out.set(textEncoder.encode(type.slice(0, 4)), 4);
  let offset = 8;
  for (const p of payloads) {
    if (!p || !p.byteLength) continue;
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function makeFullBox(type, version, flags, ...payloads) {
  const vf = new Uint8Array(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >>> 16) & 0xff;
  vf[2] = (flags >>> 8) & 0xff;
  vf[3] = flags & 0xff;
  return makeBox(type, vf, ...payloads);
}

function concatUint8(arrays) {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}

function getTrackHandlerType(u8, trakBox) {
  const children = parseBoxes(u8, trakBox.dataStart, trakBox.end);
  const mdia = children.find((b) => b.type === 'mdia');
  if (!mdia) return '';
  const mdiaChildren = parseBoxes(u8, mdia.dataStart, mdia.end);
  const hdlr = mdiaChildren.find((b) => b.type === 'hdlr');
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return '';
  return readFourCC(u8, hdlr.dataStart + 8);
}

function getTrakId(u8, trakBox) {
  const children = parseBoxes(u8, trakBox.dataStart, trakBox.end);
  const tkhd = children.find((b) => b.type === 'tkhd');
  if (!tkhd) return 1;
  const version = u8[tkhd.dataStart];
  const idOffset = tkhd.dataStart + (version === 1 ? 20 : 12);
  if (idOffset + 4 > tkhd.end) return 1;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return dv.getUint32(idOffset);
}

// ---------------------------------------------------------------------------
// Container-Erkennung (fMP4 vs. MPEG-TS vs. ADTS AAC)
// ---------------------------------------------------------------------------
function skipId3(u8) {
  let pos = 0;
  while (
    pos + 10 <= u8.byteLength &&
    u8[pos] === 0x49 &&
    u8[pos + 1] === 0x44 &&
    u8[pos + 2] === 0x33
  ) {
    const flags = u8[pos + 5];
    const footer = (flags & 0x10) !== 0 ? 10 : 0;
    const tagSize =
      ((u8[pos + 6] & 0x7f) << 21) |
      ((u8[pos + 7] & 0x7f) << 14) |
      ((u8[pos + 8] & 0x7f) << 7) |
      (u8[pos + 9] & 0x7f);
    pos += 10 + tagSize + footer;
  }
  return pos;
}

export function detectContainer(initBuf, segmentBuffers) {
  if (initBuf && initBuf.byteLength >= 8) {
    const boxes = parseBoxes(new Uint8Array(initBuf));
    if (boxes.some((b) => b.type === 'ftyp' || b.type === 'moov' || b.type === 'styp')) {
      return 'fmp4';
    }
  }
  const firstBuf = segmentBuffers?.find((b) => b && b.byteLength >= 8);
  if (!firstBuf) return 'unknown';
  const u8 = new Uint8Array(firstBuf);
  const boxes = parseBoxes(u8);
  if (
    boxes.some(
      (b) =>
        b.type === 'ftyp' ||
        b.type === 'styp' ||
        b.type === 'sidx' ||
        b.type === 'moov' ||
        b.type === 'moof'
    )
  ) {
    return 'fmp4';
  }
  const start = skipId3(u8);
  if (start + 2 <= u8.byteLength && u8[start] === 0xff && (u8[start + 1] & 0xf0) === 0xf0) {
    return 'adts';
  }
  for (let i = start; i + 188 <= Math.min(u8.byteLength, start + 1880); i++) {
    if (u8[i] === 0x47 && (i + 188 >= u8.byteLength || u8[i + 188] === 0x47)) {
      return 'ts';
    }
  }
  if (u8[start] === 0x47) return 'ts';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 1. fMP4 Track Extractor (extrahiert Samples & Codec-Boxen aus Init + Segmenten)
// ---------------------------------------------------------------------------
function findMoovSource(initBuf, segmentBuffers) {
  if (initBuf && initBuf.byteLength >= 8) {
    const u8 = new Uint8Array(initBuf);
    const boxes = parseBoxes(u8);
    const moov = boxes.find((b) => b.type === 'moov');
    if (moov) return { u8, moov };
  }
  for (const buf of segmentBuffers || []) {
    if (!buf || buf.byteLength < 8) continue;
    const u8 = new Uint8Array(buf);
    const boxes = parseBoxes(u8);
    const moov = boxes.find((b) => b.type === 'moov');
    if (moov) return { u8, moov };
  }
  return null;
}

export function extractFmp4Track(initBuf, segmentBuffers, expectedHandler) {
  const src = findMoovSource(initBuf, segmentBuffers);
  if (!src) return null;

  const { u8: initU8, moov } = src;
  const initDv = new DataView(initU8.buffer, initU8.byteOffset, initU8.byteLength);
  const moovKids = parseBoxes(initU8, moov.dataStart, moov.end);
  const traks = moovKids.filter((b) => b.type === 'trak');
  if (!traks.length) return null;

  const trak = traks.find((t) => getTrackHandlerType(initU8, t) === expectedHandler) || (traks.length === 1 ? traks[0] : null);
  if (!trak) return null;

  const handlerType = getTrackHandlerType(initU8, trak) || expectedHandler;
  const origTrackId = getTrakId(initU8, trak);

  const trakKids = parseBoxes(initU8, trak.dataStart, trak.end);
  const tkhd = trakKids.find((b) => b.type === 'tkhd');
  const mdia = trakKids.find((b) => b.type === 'mdia');
  if (!mdia) return null;

  let width = 0;
  let height = 0;
  if (tkhd && tkhd.end - tkhd.start >= 84) {
    width = initDv.getUint16(tkhd.end - 8);
    height = initDv.getUint16(tkhd.end - 4);
  }

  const mdiaKids = parseBoxes(initU8, mdia.dataStart, mdia.end);
  const mdhd = mdiaKids.find((b) => b.type === 'mdhd');
  const minf = mdiaKids.find((b) => b.type === 'minf');
  if (!mdhd || !minf) return null;

  const mdhdVersion = initU8[mdhd.dataStart];
  const timescaleOffset = mdhd.dataStart + (mdhdVersion === 1 ? 20 : 12);
  const timescale = timescaleOffset + 4 <= mdhd.end ? initDv.getUint32(timescaleOffset) || 90000 : 90000;

  const minfKids = parseBoxes(initU8, minf.dataStart, minf.end);
  const stbl = minfKids.find((b) => b.type === 'stbl');
  if (!stbl) return null;

  const stblKids = parseBoxes(initU8, stbl.dataStart, stbl.end);
  const stsd = stblKids.find((b) => b.type === 'stsd');
  if (!stsd) return null;

  const stsdBytes = initU8.slice(stsd.start, stsd.end);

  // Falls Breite/Höhe in tkhd 0 war, aus VisualSampleEntry in stsd lesen
  if (handlerType === 'vide' && (!width || !height) && stsd.dataStart + 8 < stsd.end) {
    const entries = parseBoxes(initU8, stsd.dataStart + 8, stsd.end);
    if (entries[0] && entries[0].dataStart + 28 <= entries[0].end) {
      width = initDv.getUint16(entries[0].dataStart + 24) || width;
      height = initDv.getUint16(entries[0].dataStart + 26) || height;
    }
  }

  // Standardwerte aus mvex -> trex lesen
  let defaultSampleDuration = 0;
  let defaultSampleSize = 0;
  let defaultSampleFlags = 0;
  const mvex = moovKids.find((b) => b.type === 'mvex');
  if (mvex) {
    const mvexKids = parseBoxes(initU8, mvex.dataStart, mvex.end);
    const trexes = mvexKids.filter((b) => b.type === 'trex');
    const trex =
      trexes.find((tx) => tx.dataStart + 8 <= tx.end && initDv.getUint32(tx.dataStart + 4) === origTrackId) ||
      trexes[0];
    if (trex && trex.dataStart + 24 <= trex.end) {
      defaultSampleDuration = initDv.getUint32(trex.dataStart + 12);
      defaultSampleSize = initDv.getUint32(trex.dataStart + 16);
      defaultSampleFlags = initDv.getUint32(trex.dataStart + 20);
    }
  }

  const samples = [];
  const chunks = [];

  for (const segBuf of segmentBuffers || []) {
    if (!segBuf || segBuf.byteLength < 8) continue;
    const u8 = new Uint8Array(segBuf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const boxes = parseBoxes(u8);

    for (let bIdx = 0; bIdx < boxes.length; bIdx++) {
      if (boxes[bIdx].type !== 'moof') continue;
      const moof = boxes[bIdx];

      // Zugehörige mdat-Box(en) nach diesem moof (vor dem nächsten moof) suchen
      const mdats = [];
      for (let mIdx = bIdx + 1; mIdx < boxes.length && boxes[mIdx].type !== 'moof'; mIdx++) {
        if (boxes[mIdx].type === 'mdat') mdats.push(boxes[mIdx]);
      }
      const primaryMdat = mdats[0] || null;
      let mdatCursor = primaryMdat ? primaryMdat.dataStart : 0;

      const moofKids = parseBoxes(u8, moof.dataStart, moof.end);
      const trafs = moofKids.filter((b) => b.type === 'traf');

      for (const traf of trafs) {
        const trafKids = parseBoxes(u8, traf.dataStart, traf.end);
        const tfhd = trafKids.find((b) => b.type === 'tfhd');
        if (!tfhd || tfhd.dataStart + 8 > tfhd.end) continue;

        const tfFlags =
          ((u8[tfhd.dataStart + 1] << 16) | (u8[tfhd.dataStart + 2] << 8) | u8[tfhd.dataStart + 3]) >>> 0;
        const tfTrackId = dv.getUint32(tfhd.dataStart + 4);

        // Falls ein Segment mehrere Spuren enthält, nur die passende Spur extrahieren
        if (trafs.length > 1 && tfTrackId !== origTrackId) continue;

        let tfPos = tfhd.dataStart + 8;
        let baseDataOffset = null;
        let trafDefaultDuration = defaultSampleDuration;
        let trafDefaultSize = defaultSampleSize;
        let trafDefaultFlags = defaultSampleFlags;

        if (tfFlags & 0x000001) {
          if (tfPos + 8 <= tfhd.end) {
            baseDataOffset = dv.getUint32(tfPos) * 0x100000000 + dv.getUint32(tfPos + 4);
          }
          tfPos += 8;
        }
        if (tfFlags & 0x000002) tfPos += 4;
        if (tfFlags & 0x000008) {
          if (tfPos + 4 <= tfhd.end) trafDefaultDuration = dv.getUint32(tfPos);
          tfPos += 4;
        }
        if (tfFlags & 0x000010) {
          if (tfPos + 4 <= tfhd.end) trafDefaultSize = dv.getUint32(tfPos);
          tfPos += 4;
        }
        if (tfFlags & 0x000020) {
          if (tfPos + 4 <= tfhd.end) trafDefaultFlags = dv.getUint32(tfPos);
          tfPos += 4;
        }

        const tfdt = trafKids.find((b) => b.type === 'tfdt');
        let baseDecodeTime = null;
        if (tfdt && tfdt.dataStart + 8 <= tfdt.end) {
          const tfdtVer = u8[tfdt.dataStart];
          baseDecodeTime =
            tfdtVer === 1 && tfdt.dataStart + 12 <= tfdt.end
              ? dv.getUint32(tfdt.dataStart + 4) * 0x100000000 + dv.getUint32(tfdt.dataStart + 8)
              : dv.getUint32(tfdt.dataStart + 4);
        }

        const truns = trafKids.filter((b) => b.type === 'trun');
        for (const trun of truns) {
          if (trun.dataStart + 8 > trun.end) continue;
          const trFlags =
            ((u8[trun.dataStart + 1] << 16) | (u8[trun.dataStart + 2] << 8) | u8[trun.dataStart + 3]) >>> 0;
          const sampleCount = dv.getUint32(trun.dataStart + 4);
          if (!sampleCount) continue;

          let trPos = trun.dataStart + 8;
          let dataOffset = null;
          let firstSampleFlags = null;

          if (trFlags & 0x000001) {
            if (trPos + 4 <= trun.end) dataOffset = dv.getInt32(trPos);
            trPos += 4;
          }
          if (trFlags & 0x000004) {
            if (trPos + 4 <= trun.end) firstSampleFlags = dv.getUint32(trPos);
            trPos += 4;
          }

          const runSamples = [];
          let runByteLen = 0;

          for (let s = 0; s < sampleCount; s++) {
            let duration = trafDefaultDuration;
            let size = trafDefaultSize;
            let flags = s === 0 && firstSampleFlags != null ? firstSampleFlags : trafDefaultFlags;
            let cts = 0;

            if (trFlags & 0x000100) {
              if (trPos + 4 <= trun.end) duration = dv.getUint32(trPos);
              trPos += 4;
            }
            if (trFlags & 0x000200) {
              if (trPos + 4 <= trun.end) size = dv.getUint32(trPos);
              trPos += 4;
            }
            if (trFlags & 0x000400) {
              if (trPos + 4 <= trun.end) flags = dv.getUint32(trPos);
              trPos += 4;
            }
            if (trFlags & 0x000800) {
              if (trPos + 4 <= trun.end) cts = dv.getInt32(trPos);
              trPos += 4;
            }

            const isNonSync = (flags & 0x00010000) !== 0 || ((flags >>> 24) & 0x03) === 1;
            const hasExplicitFlags = (trFlags & 0x000400) !== 0 || (s === 0 && (trFlags & 0x000004) !== 0);
            const isSync = handlerType === 'vide' ? (hasExplicitFlags ? !isNonSync : s === 0 || !isNonSync) : true;

            runSamples.push({ duration, size, cts, isSync });
            runByteLen += size;
          }

          if (runByteLen === 0 && sampleCount === 1 && primaryMdat) {
            const inferred = primaryMdat.end - primaryMdat.dataStart;
            if (inferred > 0) {
              runSamples[0].size = inferred;
              runByteLen = inferred;
            }
          }
          if (runByteLen <= 0) continue;

          // 3-stufige Offset-Auflösung (robust gegen verschobene base_data_offsets in DASH/HLS)
          let sliceStart = -1;
          if (dataOffset != null) {
            const fromMoof = moof.start + dataOffset;
            if (
              primaryMdat &&
              fromMoof >= primaryMdat.dataStart &&
              fromMoof + runByteLen <= primaryMdat.end
            ) {
              sliceStart = fromMoof;
            } else if (baseDataOffset != null) {
              const fromBase = baseDataOffset + dataOffset;
              if (
                primaryMdat &&
                fromBase >= primaryMdat.dataStart &&
                fromBase + runByteLen <= primaryMdat.end
              ) {
                sliceStart = fromBase;
              }
            }
            if (sliceStart === -1 && fromMoof >= 0 && fromMoof + runByteLen <= u8.byteLength) {
              sliceStart = fromMoof;
            }
          }
          if (
            sliceStart === -1 &&
            primaryMdat &&
            mdatCursor >= primaryMdat.dataStart &&
            mdatCursor + runByteLen <= primaryMdat.end
          ) {
            sliceStart = mdatCursor;
          }
          if (sliceStart === -1 || sliceStart + runByteLen > u8.byteLength) continue;

          mdatCursor = sliceStart + runByteLen;
          chunks.push({
            data: u8.subarray(sliceStart, sliceStart + runByteLen),
            sampleCount: runSamples.length,
            baseDecodeTime,
            firstSampleIdx: samples.length,
          });
          for (const rs of runSamples) samples.push(rs);
        }
      }
    }
  }

  if (!samples.length || !chunks.length) return null;

  // Falls Sample-Dauern 0 waren, aus tfdt-Differenzen oder Fallback ergänzen
  const fallbackDelta = handlerType === 'vide' ? Math.max(1, Math.round(timescale / 30)) : 1024;
  for (let c = 0; c < chunks.length; c++) {
    const ch = chunks[c];
    const firstSample = samples[ch.firstSampleIdx];
    if (firstSample && !firstSample.duration) {
      let inferred = fallbackDelta;
      if (ch.baseDecodeTime != null && chunks[c + 1]?.baseDecodeTime != null) {
        const diff = chunks[c + 1].baseDecodeTime - ch.baseDecodeTime;
        if (diff > 0 && ch.sampleCount > 0) {
          inferred = Math.max(1, Math.round(diff / ch.sampleCount));
        }
      }
      for (let i = 0; i < ch.sampleCount; i++) {
        if (!samples[ch.firstSampleIdx + i].duration) {
          samples[ch.firstSampleIdx + i].duration = inferred;
        }
      }
    }
  }
  for (const s of samples) {
    if (!s.duration || s.duration <= 0) s.duration = fallbackDelta;
  }

  return {
    handlerType,
    timescale,
    width: width || 1920,
    height: height || 1080,
    stsdBytes,
    samples,
    chunks,
  };
}

// ---------------------------------------------------------------------------
// 2. ADTS AAC & MPEG-TS Track Extractor -> Standard MP4 Track
// ---------------------------------------------------------------------------
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function buildMp4aStsd(profileObjectType, freqIndex, channelConfig, sampleRate) {
  const asc0 = ((profileObjectType & 0x1f) << 3) | ((freqIndex >>> 1) & 0x07);
  const asc1 = ((freqIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);

  const esdsPayload = new Uint8Array([
    0x03, 0x19, 0x00, 0x02, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, asc0, asc1,
    0x06, 0x01, 0x02,
  ]);
  const esdsBox = makeFullBox('esds', 0, 0, esdsPayload);

  const mp4aHeader = new Uint8Array(28);
  const dv = new DataView(mp4aHeader.buffer);
  dv.setUint16(6, 1); // data_reference_index = 1
  dv.setUint16(16, channelConfig || 2);
  dv.setUint16(18, 16); // sampleSize = 16
  dv.setUint32(24, (sampleRate || 48000) << 16);

  const mp4aBox = makeBox('mp4a', mp4aHeader, esdsBox);
  const stsdCount = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
  return makeFullBox('stsd', 0, 0, stsdCount, mp4aBox);
}

function buildAvc1Stsd(sps, pps, width, height) {
  const profileIdc = sps.length > 1 ? sps[1] : 0x64;
  const profileCompat = sps.length > 2 ? sps[2] : 0x00;
  const levelIdc = sps.length > 3 ? sps[3] : 0x1f;

  const avcCPayload = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  const avcCDv = new DataView(avcCPayload.buffer);
  avcCPayload[0] = 1; // configurationVersion
  avcCPayload[1] = profileIdc;
  avcCPayload[2] = profileCompat;
  avcCPayload[3] = levelIdc;
  avcCPayload[4] = 0xff; // 4-byte NAL length
  avcCPayload[5] = 0xe1; // 1 SPS
  avcCDv.setUint16(6, sps.byteLength);
  avcCPayload.set(sps, 8);
  let p = 8 + sps.byteLength;
  avcCPayload[p++] = 1; // 1 PPS
  avcCDv.setUint16(p, pps.byteLength);
  p += 2;
  avcCPayload.set(pps, p);

  const avcCBox = makeBox('avcC', avcCPayload);

  const avc1Header = new Uint8Array(78);
  const dv = new DataView(avc1Header.buffer);
  dv.setUint16(6, 1); // data_reference_index = 1
  dv.setUint16(24, width || 1920);
  dv.setUint16(26, height || 1080);
  dv.setUint32(28, 0x00480000); // horizresolution 72 dpi
  dv.setUint32(32, 0x00480000); // vertresolution 72 dpi
  dv.setUint16(40, 1); // frame_count = 1
  avc1Header[74] = 0x00;
  avc1Header[75] = 0x18; // depth = 24
  dv.setInt16(76, -1); // pre_defined = -1

  const avc1Box = makeBox('avc1', avc1Header, avcCBox);
  const stsdCount = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
  return makeFullBox('stsd', 0, 0, stsdCount, avc1Box);
}

function parseAdtsFramesFromBytes(u8, samples, chunkPayloads) {
  let pos = skipId3(u8);
  let meta = null;
  const rawFrames = [];

  while (pos + 7 <= u8.byteLength) {
    if (u8[pos] === 0x49 && u8[pos + 1] === 0x44 && u8[pos + 2] === 0x33) {
      pos += skipId3(u8.subarray(pos));
      continue;
    }
    if (u8[pos] !== 0xff || (u8[pos + 1] & 0xf0) !== 0xf0) {
      pos++;
      continue;
    }
    const protectionAbsent = u8[pos + 1] & 0x01;
    const headerLen = protectionAbsent ? 7 : 9;
    const profileObjectType = ((u8[pos + 2] >>> 6) & 0x03) + 1;
    const freqIndex = (u8[pos + 2] >>> 2) & 0x0f;
    const channelConfig = ((u8[pos + 2] & 0x01) << 2) | ((u8[pos + 3] >>> 6) & 0x03);
    const frameLength = ((u8[pos + 3] & 0x03) << 11) | (u8[pos + 4] << 3) | ((u8[pos + 5] >>> 5) & 0x07);

    if (frameLength <= headerLen || pos + frameLength > u8.byteLength) break;
    if (!meta && freqIndex < AAC_SAMPLE_RATES.length) {
      meta = {
        profileObjectType,
        freqIndex,
        channelConfig: channelConfig || 2,
        sampleRate: AAC_SAMPLE_RATES[freqIndex] || 48000,
      };
    }

    const rawAac = u8.subarray(pos + headerLen, pos + frameLength);
    rawFrames.push(rawAac);
    samples.push({
      duration: 1024,
      size: rawAac.byteLength,
      cts: 0,
      isSync: true,
    });
    pos += frameLength;
  }

  if (rawFrames.length) {
    chunkPayloads.push({
      data: concatUint8(rawFrames),
      sampleCount: rawFrames.length,
    });
  }
  return meta;
}

export function extractAdtsTrack(segmentBuffers) {
  const samples = [];
  const chunks = [];
  let meta = null;

  for (const buf of segmentBuffers || []) {
    if (!buf || buf.byteLength < 7) continue;
    const m = parseAdtsFramesFromBytes(new Uint8Array(buf), samples, chunks);
    if (!meta && m) meta = m;
  }

  if (!samples.length || !chunks.length || !meta) return null;
  const stsdBytes = buildMp4aStsd(meta.profileObjectType, meta.freqIndex, meta.channelConfig, meta.sampleRate);

  return {
    handlerType: 'soun',
    timescale: meta.sampleRate,
    width: 0,
    height: 0,
    stsdBytes,
    samples,
    chunks,
  };
}

function readPesTimestamp(u8, offset) {
  if (offset + 5 > u8.byteLength) return null;
  const b0 = u8[offset];
  const b1 = u8[offset + 1];
  const b2 = u8[offset + 2];
  const b3 = u8[offset + 3];
  const b4 = u8[offset + 4];
  const hi = (b0 & 0x0e) >>> 1;
  const mid = (b1 << 7) | ((b2 & 0xfe) >>> 1);
  const lo = (b3 << 7) | ((b4 & 0xfe) >>> 1);
  return hi * 0x40000000 + (mid << 15) + lo;
}

function splitAnnexBNals(u8) {
  const nals = [];
  const len = u8.byteLength;
  let nalStart = -1;
  let i = 0;
  while (i + 3 <= len) {
    if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (i + 3 < len && u8[i + 2] === 0 && u8[i + 3] === 1))) {
      const scLen = u8[i + 2] === 1 ? 3 : 4;
      if (nalStart !== -1 && i > nalStart) {
        nals.push(u8.subarray(nalStart, i));
      }
      nalStart = i + scLen;
      i = nalStart;
    } else {
      i++;
    }
  }
  if (nalStart !== -1 && nalStart < len) {
    nals.push(u8.subarray(nalStart, len));
  }
  return nals;
}

export function extractTsTracks(segmentBuffers, { wantVideo = true, wantAudio = true, width = 1920, height = 1080 } = {}) {
  let pmtPid = -1;
  let videoPid = -1;
  let audioPid = -1;
  let videoStreamType = 0;
  let audioStreamType = 0;

  let sps = null;
  let pps = null;
  const videoFrames = []; // { data, pts, dts, isSync, segIdx }
  const audioPesPerSeg = [];
  let aacMeta = null;

  for (let segIdx = 0; segIdx < (segmentBuffers || []).length; segIdx++) {
    const buf = segmentBuffers[segIdx];
    if (!buf || buf.byteLength < 188) continue;
    const u8 = new Uint8Array(buf);

    let startOff = skipId3(u8);
    while (startOff + 188 <= u8.byteLength && u8[startOff] !== 0x47) startOff++;

    // Pass 1: PAT & PMT im Segment scannen
    for (let off = startOff; off + 188 <= u8.byteLength; off += 188) {
      if (u8[off] !== 0x47) continue;
      const pusi = (u8[off + 1] & 0x40) !== 0;
      const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
      const afc = (u8[off + 3] >>> 4) & 0x03;
      if (afc === 0 || afc === 2) continue;
      let pOff = off + 4 + (afc === 3 ? 1 + u8[off + 4] : 0);
      if (pOff >= off + 188) continue;

      if (pid === 0 && pusi) {
        const secStart = pOff + 1 + u8[pOff];
        if (secStart + 12 <= off + 188 && u8[secStart] === 0x00) {
          const secLen = ((u8[secStart + 1] & 0x0f) << 8) | u8[secStart + 2];
          const end = Math.min(off + 188, secStart + 3 + secLen - 4);
          for (let p = secStart + 8; p + 4 <= end; p += 4) {
            const progNum = (u8[p] << 8) | u8[p + 1];
            if (progNum !== 0) {
              pmtPid = ((u8[p + 2] & 0x1f) << 8) | u8[p + 3];
              break;
            }
          }
        }
      } else if (pid === pmtPid && pusi && pmtPid !== -1) {
        const secStart = pOff + 1 + u8[pOff];
        if (secStart + 16 <= off + 188 && u8[secStart] === 0x02) {
          const secLen = ((u8[secStart + 1] & 0x0f) << 8) | u8[secStart + 2];
          const progInfoLen = ((u8[secStart + 10] & 0x0f) << 8) | u8[secStart + 11];
          let pos = secStart + 12 + progInfoLen;
          const end = Math.min(off + 188, secStart + 3 + secLen - 4);
          while (pos + 5 <= end) {
            const st = u8[pos];
            const ePid = ((u8[pos + 1] & 0x1f) << 8) | u8[pos + 2];
            const esInfoLen = ((u8[pos + 3] & 0x0f) << 8) | u8[pos + 4];
            if (st === 0x1b || st === 0x24) {
              videoPid = ePid;
              videoStreamType = st;
            } else if (st === 0x0f || st === 0x03 || st === 0x04 || st === 0x11) {
              audioPid = ePid;
              audioStreamType = st;
            }
            pos += 5 + esInfoLen;
          }
        }
      }
    }

    // Pass 2: PES-Pakete für Video & Audio sammeln
    let curVideoPes = [];
    let curAudioPes = [];
    const segAudioBytes = [];

    const flushVideoPes = () => {
      if (!curVideoPes.length) return;
      const pes = concatUint8(curVideoPes);
      curVideoPes = [];
      if (pes.byteLength < 9 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return;
      const flags = (pes[7] >>> 6) & 0x03;
      const hdrLen = pes[8];
      const payloadStart = 9 + hdrLen;
      if (payloadStart >= pes.byteLength) return;

      let pts = null;
      let dts = null;
      if (flags >= 2 && payloadStart >= 14) {
        pts = readPesTimestamp(pes, 9);
        dts = flags === 3 && payloadStart >= 19 ? readPesTimestamp(pes, 14) : pts;
      }

      const nals = splitAnnexBNals(pes.subarray(payloadStart));
      let frameNals = [];
      let frameSync = false;

      const commitFrame = () => {
        if (!frameNals.length) return;
        let totalBytes = 0;
        for (const n of frameNals) totalBytes += 4 + n.byteLength;
        const sampleData = new Uint8Array(totalBytes);
        const dv = new DataView(sampleData.buffer);
        let pos = 0;
        for (const n of frameNals) {
          dv.setUint32(pos, n.byteLength);
          sampleData.set(n, pos + 4);
          pos += 4 + n.byteLength;
        }
        videoFrames.push({
          data: sampleData,
          pts: pts ?? dts ?? 0,
          dts: dts ?? pts ?? 0,
          isSync: frameSync,
          segIdx,
        });
        frameNals = [];
        frameSync = false;
      };

      for (const nal of nals) {
        if (!nal.byteLength) continue;
        const nalType = nal[0] & 0x1f;
        if (nalType === 7) {
          if (!sps) sps = nal.slice();
        } else if (nalType === 8) {
          if (!pps) pps = nal.slice();
        } else if (nalType === 9) {
          if (frameNals.length) commitFrame();
        } else {
          if (nalType === 5) frameSync = true;
          frameNals.push(nal);
        }
      }
      commitFrame();
    };

    const flushAudioPes = () => {
      if (!curAudioPes.length) return;
      const pes = concatUint8(curAudioPes);
      curAudioPes = [];
      if (pes.byteLength < 9 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return;
      const hdrLen = pes[8];
      const payloadStart = 9 + hdrLen;
      if (payloadStart < pes.byteLength) {
        segAudioBytes.push(pes.subarray(payloadStart));
      }
    };

    for (let off = startOff; off + 188 <= u8.byteLength; off += 188) {
      if (u8[off] !== 0x47) continue;
      const pusi = (u8[off + 1] & 0x40) !== 0;
      const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
      const afc = (u8[off + 3] >>> 4) & 0x03;
      if (afc === 0 || afc === 2) continue;
      const pOff = off + 4 + (afc === 3 ? 1 + u8[off + 4] : 0);
      if (pOff >= off + 188) continue;
      const payload = u8.subarray(pOff, off + 188);

      if (wantVideo && pid === videoPid && videoPid !== -1) {
        if (pusi) flushVideoPes();
        curVideoPes.push(payload);
      } else if (wantAudio && pid === audioPid && audioPid !== -1) {
        if (pusi) flushAudioPes();
        curAudioPes.push(payload);
      }
    }
    flushVideoPes();
    flushAudioPes();

    if (segAudioBytes.length) {
      audioPesPerSeg.push(concatUint8(segAudioBytes));
    }
  }

  let videoTrack = null;
  if (wantVideo && videoStreamType === 0x1b && sps && pps && videoFrames.length) {
    const samples = [];
    const chunks = [];
    let defaultDelta = 3000;
    for (let i = 0; i + 1 < videoFrames.length; i++) {
      const d = videoFrames[i + 1].dts - videoFrames[i].dts;
      if (d > 0 && d < 90000) {
        defaultDelta = d;
        break;
      }
    }

    let curSeg = -1;
    let curChunkDatas = [];

    const flushChunk = () => {
      if (!curChunkDatas.length) return;
      chunks.push({
        data: concatUint8(curChunkDatas),
        sampleCount: curChunkDatas.length,
      });
      curChunkDatas = [];
    };

    for (let i = 0; i < videoFrames.length; i++) {
      const vf = videoFrames[i];
      if (vf.segIdx !== curSeg) {
        flushChunk();
        curSeg = vf.segIdx;
      }
      let delta = i + 1 < videoFrames.length ? videoFrames[i + 1].dts - vf.dts : defaultDelta;
      if (delta <= 0 || delta > 90000) delta = defaultDelta;
      const cts = Math.max(-90000, Math.min(90000, vf.pts - vf.dts));

      samples.push({
        duration: delta,
        size: vf.data.byteLength,
        cts,
        isSync: vf.isSync || i === 0,
      });
      curChunkDatas.push(vf.data);
    }
    flushChunk();

    videoTrack = {
      handlerType: 'vide',
      timescale: 90000,
      width: width || 1920,
      height: height || 1080,
      stsdBytes: buildAvc1Stsd(sps, pps, width || 1920, height || 1080),
      samples,
      chunks,
    };
  }

  let audioTrack = null;
  if (wantAudio && audioStreamType === 0x0f && audioPesPerSeg.length) {
    const aSamples = [];
    const aChunks = [];
    for (const segAudio of audioPesPerSeg) {
      const m = parseAdtsFramesFromBytes(segAudio, aSamples, aChunks);
      if (!aacMeta && m) aacMeta = m;
    }
    if (aSamples.length && aChunks.length && aacMeta) {
      audioTrack = {
        handlerType: 'soun',
        timescale: aacMeta.sampleRate,
        width: 0,
        height: 0,
        stsdBytes: buildMp4aStsd(
          aacMeta.profileObjectType,
          aacMeta.freqIndex,
          aacMeta.channelConfig,
          aacMeta.sampleRate
        ),
        samples: aSamples,
        chunks: aChunks,
      };
    }
  }

  return { videoTrack, audioTrack };
}

// ---------------------------------------------------------------------------
// 3. Standard Non-Fragmented MP4 Builder (ftyp + moov + mdat)
// ---------------------------------------------------------------------------
function buildSttsBox(samples) {
  const entries = [];
  for (const s of samples) {
    const delta = Math.max(1, s.duration >>> 0);
    const last = entries[entries.length - 1];
    if (last && last.delta === delta) {
      last.count++;
    } else {
      entries.push({ count: 1, delta });
    }
  }
  const buf = new Uint8Array(4 + entries.length * 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    dv.setUint32(4 + i * 8, entries[i].count);
    dv.setUint32(8 + i * 8, entries[i].delta);
  }
  return makeFullBox('stts', 0, 0, buf);
}

function buildCttsBox(samples) {
  let minCts = 0;
  let hasNonZero = false;
  for (const s of samples) {
    const c = s.cts || 0;
    if (c !== 0) hasNonZero = true;
    if (c < minCts) minCts = c;
  }
  if (!hasNonZero) return null;

  const shift = minCts < 0 ? -minCts : 0;
  const entries = [];
  for (const s of samples) {
    const offset = (s.cts || 0) + shift;
    const last = entries[entries.length - 1];
    if (last && last.offset === offset) {
      last.count++;
    } else {
      entries.push({ count: 1, offset });
    }
  }
  const buf = new Uint8Array(4 + entries.length * 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    dv.setUint32(4 + i * 8, entries[i].count);
    dv.setUint32(8 + i * 8, entries[i].offset >>> 0);
  }
  return makeFullBox('ctts', 0, 0, buf);
}

function buildStssBox(samples) {
  const syncIndices = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].isSync) syncIndices.push(i + 1);
  }
  if (!syncIndices.length) syncIndices.push(1);
  const buf = new Uint8Array(4 + syncIndices.length * 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, syncIndices.length);
  for (let i = 0; i < syncIndices.length; i++) {
    dv.setUint32(4 + i * 4, syncIndices[i]);
  }
  return makeFullBox('stss', 0, 0, buf);
}

function buildStscBox(chunks) {
  const entries = [];
  for (let i = 0; i < chunks.length; i++) {
    const count = chunks[i].sampleCount;
    const last = entries[entries.length - 1];
    if (!last || last.count !== count) {
      entries.push({ firstChunk: i + 1, count, descIdx: 1 });
    }
  }
  const buf = new Uint8Array(4 + entries.length * 12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    dv.setUint32(4 + i * 12, entries[i].firstChunk);
    dv.setUint32(8 + i * 12, entries[i].count);
    dv.setUint32(12 + i * 12, entries[i].descIdx);
  }
  return makeFullBox('stsc', 0, 0, buf);
}

function buildStszBox(samples) {
  const buf = new Uint8Array(8 + samples.length * 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0); // sample_size = 0 (individuelle Größen folgen)
  dv.setUint32(4, samples.length);
  for (let i = 0; i < samples.length; i++) {
    dv.setUint32(8 + i * 4, samples[i].size >>> 0);
  }
  return makeFullBox('stsz', 0, 0, buf);
}

function buildCo64Box(chunks, baseFileOffset) {
  const buf = new Uint8Array(4 + chunks.length * 8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const absOffset = baseFileOffset + chunks[i].relOffset;
    const hi = Math.floor(absOffset / 0x100000000);
    const lo = absOffset >>> 0;
    dv.setUint32(4 + i * 8, hi);
    dv.setUint32(8 + i * 8, lo);
  }
  return makeFullBox('co64', 0, 0, buf);
}

function buildMvhdBox(movieDurationMs, nextTrackId) {
  const buf = new Uint8Array(96);
  const dv = new DataView(buf.buffer);
  dv.setUint32(8, 1000); // timescale = 1000 (ms)
  dv.setUint32(12, Math.min(0xffffffff, Math.round(movieDurationMs)));
  dv.setUint32(16, 0x00010000); // rate = 1.0
  dv.setUint16(20, 0x0100); // volume = 1.0
  // Unity Matrix
  dv.setUint32(32, 0x00010000);
  dv.setUint32(48, 0x00010000);
  dv.setUint32(64, 0x40000000);
  dv.setUint32(92, nextTrackId);
  return makeFullBox('mvhd', 0, 0, buf);
}

function buildTkhdBox(trackId, trackDurationMs, isAudio, width, height) {
  const buf = new Uint8Array(80);
  const dv = new DataView(buf.buffer);
  dv.setUint32(8, trackId);
  dv.setUint32(16, Math.min(0xffffffff, Math.round(trackDurationMs)));
  dv.setUint16(32, isAudio ? 0x0100 : 0x0000); // volume
  // Unity Matrix
  dv.setUint32(36, 0x00010000);
  dv.setUint32(52, 0x00010000);
  dv.setUint32(68, 0x40000000);
  dv.setUint32(72, isAudio ? 0 : (width || 1920) << 16);
  dv.setUint32(76, isAudio ? 0 : (height || 1080) << 16);
  // flags = 0x000003 (Track_enabled | Track_in_movie)
  return makeFullBox('tkhd', 0, 0x000003, buf);
}

function buildMdhdBox(timescale, totalDuration) {
  if (totalDuration > 0xffffffff) {
    const buf = new Uint8Array(32);
    const dv = new DataView(buf.buffer);
    dv.setUint32(16, timescale);
    dv.setUint32(20, Math.floor(totalDuration / 0x100000000));
    dv.setUint32(24, totalDuration >>> 0);
    dv.setUint16(28, 0x55c4); // 'und'
    return makeFullBox('mdhd', 1, 0, buf);
  }
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  dv.setUint32(8, timescale);
  dv.setUint32(12, totalDuration >>> 0);
  dv.setUint16(16, 0x55c4); // 'und'
  return makeFullBox('mdhd', 0, 0, buf);
}

function buildHdlrBox(handlerType) {
  const name = handlerType === 'soun' ? 'SoundHandler\0' : 'VideoHandler\0';
  const nameBytes = textEncoder.encode(name);
  const buf = new Uint8Array(20 + nameBytes.byteLength);
  buf.set(textEncoder.encode(handlerType.slice(0, 4)), 4);
  buf.set(nameBytes, 20);
  return makeFullBox('hdlr', 0, 0, buf);
}

function buildMinfHeaderBox(handlerType) {
  if (handlerType === 'soun') {
    return makeFullBox('smhd', 0, 0, new Uint8Array(4));
  }
  return makeFullBox('vmhd', 0, 1, new Uint8Array(8));
}

function buildDinfBox() {
  const urlBox = makeFullBox('url ', 0, 1);
  const drefPayload = new Uint8Array(4);
  new DataView(drefPayload.buffer).setUint32(0, 1);
  const drefBox = makeFullBox('dref', 0, 0, drefPayload, urlBox);
  return makeBox('dinf', drefBox);
}

export function buildStandardMp4(tracks) {
  const validTracks = (tracks || []).filter((t) => t && t.samples?.length && t.chunks?.length && t.stsdBytes);
  if (!validTracks.length) return null;

  // Chunks zeitlich verschachteln (Video Chunk 0, Audio Chunk 0, Video Chunk 1, Audio Chunk 1, ...)
  const mdatParts = [];
  let mdatPayloadBytes = 0;

  const maxChunks = Math.max(...validTracks.map((t) => t.chunks.length));
  for (let i = 0; i < maxChunks; i++) {
    for (const t of validTracks) {
      if (i < t.chunks.length) {
        const ch = t.chunks[i];
        ch.relOffset = mdatPayloadBytes;
        mdatParts.push(ch.data);
        mdatPayloadBytes += ch.data.byteLength;
      }
    }
  }

  for (const t of validTracks) {
    let totalDur = 0;
    for (const s of t.samples) totalDur += s.duration;
    t.totalDuration = totalDur;
    t.durationMs = (totalDur / (t.timescale || 1000)) * 1000;
  }

  const movieDurationMs = Math.max(...validTracks.map((t) => t.durationMs || 0));

  const ftypPayload = new Uint8Array(24);
  ftypPayload.set(textEncoder.encode('isom'), 0);
  new DataView(ftypPayload.buffer).setUint32(4, 0x00000200);
  ftypPayload.set(textEncoder.encode('isomiso2avc1mp41'), 8);
  const ftypBox = makeBox('ftyp', ftypPayload);

  // mdat-Header (8 Bytes für < 4 GB, 16 Bytes für >= 4 GB)
  const use64BitMdat = mdatPayloadBytes + 16 > 0xffffffff;
  const mdatHeader = new Uint8Array(use64BitMdat ? 16 : 8);
  const mdatDv = new DataView(mdatHeader.buffer);
  mdatHeader.set(textEncoder.encode('mdat'), 4);
  if (use64BitMdat) {
    mdatDv.setUint32(0, 1);
    const totalMdat = mdatPayloadBytes + 16;
    mdatDv.setUint32(8, Math.floor(totalMdat / 0x100000000));
    mdatDv.setUint32(12, totalMdat >>> 0);
  } else {
    mdatDv.setUint32(0, mdatPayloadBytes + 8);
  }

  const assembleMoov = (baseFileOffset) => {
    const mvhdBox = buildMvhdBox(movieDurationMs, validTracks.length + 1);
    const trakBoxes = validTracks.map((t, idx) => {
      const trackId = idx + 1;
      const isAudio = t.handlerType === 'soun';
      const tkhdBox = buildTkhdBox(trackId, t.durationMs, isAudio, t.width, t.height);
      const mdhdBox = buildMdhdBox(t.timescale, t.totalDuration);
      const hdlrBox = buildHdlrBox(t.handlerType);
      const mediaHdr = buildMinfHeaderBox(t.handlerType);
      const dinfBox = buildDinfBox();

      const sttsBox = buildSttsBox(t.samples);
      const cttsBox = !isAudio ? buildCttsBox(t.samples) : null;
      const stssBox = !isAudio ? buildStssBox(t.samples) : null;
      const stscBox = buildStscBox(t.chunks);
      const stszBox = buildStszBox(t.samples);
      const co64Box = buildCo64Box(t.chunks, baseFileOffset);

      const stblBox = makeBox('stbl', t.stsdBytes, sttsBox, cttsBox, stssBox, stscBox, stszBox, co64Box);
      const minfBox = makeBox('minf', mediaHdr, dinfBox, stblBox);
      const mdiaBox = makeBox('mdia', mdhdBox, hdlrBox, minfBox);
      return makeBox('trak', tkhdBox, mdiaBox);
    });
    return makeBox('moov', mvhdBox, ...trakBoxes);
  };

  // Pass 1 berechnet exakte moov-Größe; Pass 2 trägt die exakten Dateioffsets in co64 ein
  const moovPass1 = assembleMoov(0);
  const dataStartOffset = ftypBox.byteLength + moovPass1.byteLength + mdatHeader.byteLength;
  const moovBox = assembleMoov(dataStartOffset);

  return new Blob([ftypBox, moovBox, mdatHeader, ...mdatParts], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------------
// High-Level Remuxer: Kombiniert Video + Audio (oder Einzelspur) zu Standard-MP4
// ---------------------------------------------------------------------------
export function remuxStreamsToMp4({
  videoInitBuf = null,
  videoBuffers = [],
  audioInitBuf = null,
  audioBuffers = [],
  mode = 'both',
  width = 1920,
  height = 1080,
}) {
  const vContainer = detectContainer(videoInitBuf, videoBuffers);
  const hasSeparateAudio = audioBuffers && audioBuffers.length > 0;
  const aContainer = hasSeparateAudio ? detectContainer(audioInitBuf, audioBuffers) : null;

  let videoTrack = null;
  let audioTrack = null;

  if (mode === 'audio') {
    if (hasSeparateAudio) {
      if (aContainer === 'fmp4') audioTrack = extractFmp4Track(audioInitBuf, audioBuffers, 'soun');
      else if (aContainer === 'adts') audioTrack = extractAdtsTrack(audioBuffers);
      else if (aContainer === 'ts') audioTrack = extractTsTracks(audioBuffers, { wantVideo: false, wantAudio: true }).audioTrack;
    }
    if (!audioTrack) {
      if (vContainer === 'fmp4') audioTrack = extractFmp4Track(videoInitBuf, videoBuffers, 'soun');
      else if (vContainer === 'adts') audioTrack = extractAdtsTrack(videoBuffers);
      else if (vContainer === 'ts') audioTrack = extractTsTracks(videoBuffers, { wantVideo: false, wantAudio: true }).audioTrack;
    }
    if (audioTrack) {
      return buildStandardMp4([audioTrack]);
    }
    return null;
  }

  // Video-Track extrahieren
  if (vContainer === 'fmp4') {
    videoTrack = extractFmp4Track(videoInitBuf, videoBuffers, 'vide');
    if (mode === 'both' && !hasSeparateAudio) {
      audioTrack = extractFmp4Track(videoInitBuf, videoBuffers, 'soun');
    }
  } else if (vContainer === 'ts') {
    const extracted = extractTsTracks(videoBuffers, {
      wantVideo: true,
      wantAudio: mode === 'both' && !hasSeparateAudio,
      width,
      height,
    });
    videoTrack = extracted.videoTrack;
    if (mode === 'both' && !hasSeparateAudio) {
      audioTrack = extracted.audioTrack;
    }
  }

  // Separates Audio extrahieren (falls vorhanden und mode === 'both')
  if (mode === 'both' && hasSeparateAudio) {
    if (aContainer === 'fmp4') {
      audioTrack = extractFmp4Track(audioInitBuf, audioBuffers, 'soun');
    } else if (aContainer === 'adts') {
      audioTrack = extractAdtsTrack(audioBuffers);
    } else if (aContainer === 'ts') {
      audioTrack = extractTsTracks(audioBuffers, { wantVideo: false, wantAudio: true }).audioTrack;
    }
  }

  if (!videoTrack) return null;
  if (mode === 'both' && hasSeparateAudio && !audioTrack) {
    // Falls separate Audiospur angefordert, aber nicht als MP4-Track extrahierbar -> Fallback nutzen
    return null;
  }

  const tracks = mode === 'video' ? [videoTrack] : [videoTrack, audioTrack].filter(Boolean);
  return buildStandardMp4(tracks);
}

// ---------------------------------------------------------------------------
// Fallback 1: Verbesserter fMP4-Fragment-Combiner (falls Standard-Remux nicht greift)
// ---------------------------------------------------------------------------
function setTrakIdAndEnable(u8, trakBox, newId) {
  const copy = u8.slice(trakBox.start, trakBox.end);
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const children = parseBoxes(copy, trakBox.headerSize, copy.byteLength);
  const tkhd = children.find((b) => b.type === 'tkhd');
  if (tkhd) {
    copy[tkhd.dataStart + 3] |= 0x03; // Track_enabled | Track_in_movie erzwingen
    const version = copy[tkhd.dataStart];
    const idOffset = tkhd.dataStart + (version === 1 ? 20 : 12);
    if (idOffset + 4 <= tkhd.end) {
      dv.setUint32(idOffset, newId);
    }
  }
  return copy;
}

function extractTrexAndRewriteId(u8, moovBox, targetHandler, newId) {
  const children = parseBoxes(u8, moovBox.dataStart, moovBox.end);
  const traks = children.filter((b) => b.type === 'trak');
  const matchingTrak = traks.find((t) => getTrackHandlerType(u8, t) === targetHandler) || traks[0];
  const origTrackId = matchingTrak ? getTrakId(u8, matchingTrak) : 1;

  const mvex = children.find((b) => b.type === 'mvex');
  if (mvex) {
    const mvexChildren = parseBoxes(u8, mvex.dataStart, mvex.end);
    const trexes = mvexChildren.filter((b) => b.type === 'trex');
    let chosen = trexes.find((tx) => {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      return tx.dataStart + 8 <= tx.end && dv.getUint32(tx.dataStart + 4) === origTrackId;
    });
    if (!chosen) chosen = trexes[0];
    if (chosen) {
      const copy = u8.slice(chosen.start, chosen.end);
      const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
      dv.setUint32(chosen.headerSize + 4, newId);
      return copy;
    }
  }

  const payload = new Uint8Array(20);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, newId);
  dv.setUint32(4, 1);
  return makeFullBox('trex', 0, 0, payload);
}

export function buildCombinedInitSegment(videoInitBuf, audioInitBuf) {
  const vU8 = new Uint8Array(videoInitBuf);
  const aU8 = new Uint8Array(audioInitBuf);

  const vBoxes = parseBoxes(vU8);
  const aBoxes = parseBoxes(aU8);

  const ftyp = vBoxes.find((b) => b.type === 'ftyp') || aBoxes.find((b) => b.type === 'ftyp');
  const vMoov = vBoxes.find((b) => b.type === 'moov');
  const aMoov = aBoxes.find((b) => b.type === 'moov');
  if (!vMoov || !aMoov) return null;

  const vMoovKids = parseBoxes(vU8, vMoov.dataStart, vMoov.end);
  const aMoovKids = parseBoxes(aU8, aMoov.dataStart, aMoov.end);

  const mvhd = vMoovKids.find((b) => b.type === 'mvhd') || aMoovKids.find((b) => b.type === 'mvhd');
  if (!mvhd) return null;

  const mvhdBytes = vU8.slice(mvhd.start, mvhd.end);
  if (mvhdBytes.byteLength >= 12) {
    new DataView(mvhdBytes.buffer).setUint32(mvhdBytes.byteLength - 4, 3);
  }

  const vTraks = vMoovKids.filter((b) => b.type === 'trak');
  const aTraks = aMoovKids.filter((b) => b.type === 'trak');

  const vTrakBox = vTraks.find((t) => getTrackHandlerType(vU8, t) === 'vide') || vTraks[0];
  const aTrakBox = aTraks.find((t) => getTrackHandlerType(aU8, t) === 'soun') || aTraks[0];
  if (!vTrakBox || !aTrakBox) return null;

  const videoTrakBytes = setTrakIdAndEnable(vU8, vTrakBox, 1);
  const audioTrakBytes = setTrakIdAndEnable(aU8, aTrakBox, 2);

  const videoTrexBytes = extractTrexAndRewriteId(vU8, vMoov, 'vide', 1);
  const audioTrexBytes = extractTrexAndRewriteId(aU8, aMoov, 'soun', 2);
  const mvexBytes = makeBox('mvex', videoTrexBytes, audioTrexBytes);

  const moovBytes = makeBox('moov', mvhdBytes, videoTrakBytes, audioTrakBytes, mvexBytes);
  const ftypBytes = ftyp ? vU8.slice(ftyp.start, ftyp.end) : new Uint8Array(0);

  return new Blob([ftypBytes, moovBytes], { type: 'video/mp4' });
}

export function rewriteFragmentSegment(segBuf, newTrackId, seqCounter) {
  const u8 = new Uint8Array(segBuf.slice ? segBuf.slice(0) : segBuf);
  const boxes = parseBoxes(u8);
  const keptChunks = [];

  for (const box of boxes) {
    if (box.type === 'sidx' || box.type === 'styp' || box.type === 'ftyp' || box.type === 'moov') {
      continue;
    }
    if (box.type === 'moof') {
      const moofChildren = parseBoxes(u8, box.dataStart, box.end);
      for (const child of moofChildren) {
        if (child.type === 'mfhd' && child.dataStart + 8 <= child.end) {
          const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
          dv.setUint32(child.dataStart + 4, seqCounter.value++);
        } else if (child.type === 'traf') {
          const trafChildren = parseBoxes(u8, child.dataStart, child.end);
          for (const tc of trafChildren) {
            if (tc.type === 'tfhd' && tc.dataStart + 8 <= tc.end) {
              const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
              dv.setUint32(tc.dataStart + 4, newTrackId);
              // Falls kein base-data-offset vorhanden ist, default-base-is-moof (0x020000) setzen
              if ((u8[tc.dataStart + 3] & 0x01) === 0) {
                u8[tc.dataStart + 1] |= 0x02;
              }
            }
          }
        }
      }
    }
    keptChunks.push(u8.subarray(box.start, box.end));
  }

  return new Blob(keptChunks);
}

export function filterMp4Tracks(buf, keepHandler) {
  const remuxed = remuxStreamsToMp4({
    videoInitBuf: null,
    videoBuffers: [buf],
    mode: keepHandler === 'soun' ? 'audio' : 'video',
  });
  if (remuxed) return remuxed;

  const u8 = new Uint8Array(buf);
  const topBoxes = parseBoxes(u8);
  const moov = topBoxes.find((b) => b.type === 'moov');
  if (!moov) return new Blob([u8]);

  const moovKids = parseBoxes(u8, moov.dataStart, moov.end);
  const traks = moovKids.filter((b) => b.type === 'trak');
  if (traks.length <= 1) return new Blob([u8]);

  const keptTrackIds = new Set();
  for (const t of traks) {
    if (getTrackHandlerType(u8, t) === keepHandler) {
      keptTrackIds.add(getTrakId(u8, t));
    }
  }
  if (!keptTrackIds.size) return new Blob([u8]);

  const outParts = [];
  for (const box of topBoxes) {
    if (box.type === 'moov') {
      const newMoovParts = [];
      for (const child of moovKids) {
        if (child.type === 'trak') {
          if (keptTrackIds.has(getTrakId(u8, child))) {
            newMoovParts.push(u8.subarray(child.start, child.end));
          }
        } else if (child.type === 'mvex') {
          const mvexKids = parseBoxes(u8, child.dataStart, child.end);
          const keptMvex = mvexKids
            .filter((mk) => {
              if (mk.type !== 'trex' || mk.dataStart + 8 > mk.end) return true;
              const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
              return keptTrackIds.has(dv.getUint32(mk.dataStart + 4));
            })
            .map((mk) => u8.subarray(mk.start, mk.end));
          if (keptMvex.length) newMoovParts.push(makeBox('mvex', ...keptMvex));
        } else {
          newMoovParts.push(u8.subarray(child.start, child.end));
        }
      }
      outParts.push(makeBox('moov', ...newMoovParts));
    } else if (box.type === 'sidx') {
      continue;
    } else {
      outParts.push(u8.subarray(box.start, box.end));
    }
  }

  return new Blob(outParts);
}

// ---------------------------------------------------------------------------
// Fallback 2: 2-Pass Interleaved MPEG-TS Combiner
// ---------------------------------------------------------------------------
function mpegCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 24;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function inspectTsSegment(u8) {
  let pmtPid = -1;
  let streamPid = -1;
  let streamType = 0x0f;
  for (let off = 0; off + 188 <= u8.byteLength; off += 188) {
    if (u8[off] !== 0x47) continue;
    const pusi = (u8[off + 1] & 0x40) !== 0;
    const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
    const afc = (u8[off + 3] >>> 4) & 0x03;
    if (afc === 0 || afc === 2) continue;
    const pOff = off + 4 + (afc === 3 ? 1 + u8[off + 4] : 0);
    if (pOff >= off + 188) continue;

    if (pid === 0 && pusi) {
      const secStart = pOff + 1 + u8[pOff];
      if (secStart + 12 <= off + 188 && u8[secStart] === 0x00) {
        const secLen = ((u8[secStart + 1] & 0x0f) << 8) | u8[secStart + 2];
        const end = Math.min(off + 188, secStart + 3 + secLen - 4);
        for (let p = secStart + 8; p + 4 <= end; p += 4) {
          const progNum = (u8[p] << 8) | u8[p + 1];
          if (progNum !== 0) {
            pmtPid = ((u8[p + 2] & 0x1f) << 8) | u8[p + 3];
            break;
          }
        }
      }
    } else if (pid === pmtPid && pusi && pmtPid !== -1) {
      const secStart = pOff + 1 + u8[pOff];
      if (secStart + 16 <= off + 188 && u8[secStart] === 0x02) {
        const secLen = ((u8[secStart + 1] & 0x0f) << 8) | u8[secStart + 2];
        const progInfoLen = ((u8[secStart + 10] & 0x0f) << 8) | u8[secStart + 11];
        const esPos = secStart + 12 + progInfoLen;
        if (esPos + 5 <= secStart + 3 + secLen - 4 && esPos + 5 <= off + 188) {
          streamType = u8[esPos];
          streamPid = ((u8[esPos + 1] & 0x1f) << 8) | u8[esPos + 2];
        }
      }
    }
  }
  return { pmtPid, streamPid, streamType };
}

export function mergeTsSegmentBuffers(videoTsBuf, audioBuf, ccState = { audioCc: 0 }) {
  const vU8 = new Uint8Array(videoTsBuf);
  const aU8 = new Uint8Array(audioBuf);
  if (vU8.byteLength < 188 || vU8[0] !== 0x47) {
    return new Blob([vU8, aU8], { type: 'video/mp2t' });
  }

  const AUDIO_OUT_PID = 0x01f0; // 496 (kollidiert weder mit 0x0100/0x0101/0x0102 noch mit 0x1000)
  const vInfo = inspectTsSegment(vU8);
  const aInfo = inspectTsSegment(aU8);
  const audioType = aInfo.streamType || 0x0f;

  // Audio-TS-Pakete im 2. Pass sauber extrahieren und auf AUDIO_OUT_PID umschreiben
  const audioPackets = [];
  if (aU8.byteLength >= 188 && aU8[0] === 0x47 && aInfo.streamPid !== -1) {
    for (let off = 0; off + 188 <= aU8.byteLength; off += 188) {
      if (aU8[off] !== 0x47) continue;
      const pid = ((aU8[off + 1] & 0x1f) << 8) | aU8[off + 2];
      if (pid === aInfo.streamPid) {
        const pkt = aU8.slice(off, off + 188);
        pkt[1] = (pkt[1] & 0xe0) | ((AUDIO_OUT_PID >> 8) & 0x1f);
        pkt[2] = AUDIO_OUT_PID & 0xff;
        if ((pkt[3] & 0x10) !== 0) {
          pkt[3] = (pkt[3] & 0xf0) | (ccState.audioCc & 0x0f);
          ccState.audioCc = (ccState.audioCc + 1) & 0x0f;
        }
        audioPackets.push(pkt);
      }
    }
  }

  // Video-TS-Pakete kopieren, PMT um Audio-Spur ergänzen und Audio-Pakete gleichmäßig einflechten
  const vCopy = vU8.slice();
  const totalVPackets = Math.floor(vCopy.byteLength / 188);
  const outPackets = [];
  let audioIdx = 0;
  const step = audioPackets.length ? Math.max(1, Math.floor(totalVPackets / audioPackets.length)) : Infinity;

  for (let pIdx = 0; pIdx < totalVPackets; pIdx++) {
    const off = pIdx * 188;
    const pkt = vCopy.subarray(off, off + 188);
    if (pkt[0] === 0x47 && vInfo.pmtPid !== -1) {
      const pusi = (pkt[1] & 0x40) !== 0;
      const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
      const afc = (pkt[3] >>> 4) & 0x03;
      if (pid === vInfo.pmtPid && pusi && (afc === 1 || afc === 3)) {
        const pOff = 4 + (afc === 3 ? 1 + pkt[4] : 0);
        if (pOff < 188) {
          const secStart = pOff + 1 + pkt[pOff];
          if (secStart + 16 <= 188 && pkt[secStart] === 0x02) {
            const secLen = ((pkt[secStart + 1] & 0x0f) << 8) | pkt[secStart + 2];
            const secEnd = secStart + 3 + secLen;
            if (secEnd + 5 <= 188) {
              const crcPos = secEnd - 4;
              const newSecLen = secLen + 5;
              pkt[secStart + 1] = (pkt[secStart + 1] & 0xf0) | ((newSecLen >> 8) & 0x0f);
              pkt[secStart + 2] = newSecLen & 0xff;
              pkt[crcPos] = audioType;
              pkt[crcPos + 1] = 0xe0 | ((AUDIO_OUT_PID >> 8) & 0x1f);
              pkt[crcPos + 2] = AUDIO_OUT_PID & 0xff;
              pkt[crcPos + 3] = 0xf0;
              pkt[crcPos + 4] = 0x00;
              const crc = mpegCrc32(pkt.subarray(secStart, crcPos + 5));
              pkt[crcPos + 5] = (crc >>> 24) & 0xff;
              pkt[crcPos + 6] = (crc >>> 16) & 0xff;
              pkt[crcPos + 7] = (crc >>> 8) & 0xff;
              pkt[crcPos + 8] = crc & 0xff;
            }
          }
        }
      }
    }
    outPackets.push(pkt);
    if (pIdx > 1 && audioIdx < audioPackets.length && pIdx % step === 0) {
      outPackets.push(audioPackets[audioIdx++]);
    }
  }
  while (audioIdx < audioPackets.length) {
    outPackets.push(audioPackets[audioIdx++]);
  }

  return new Blob(outPackets, { type: 'video/mp2t' });
}
