import { parseM3U8 } from '../lib/hls.js';
import { parseMPD } from '../lib/dash.js';
import {
  remuxStreamsToMp4,
  buildCombinedInitSegment,
  rewriteFragmentSegment,
  mergeTsSegmentBuffers,
  filterMp4Tracks,
} from '../lib/muxer.js';

const jobs = new Map();
const blobUrls = new Map();

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start-job':
      runJob(msg.job);
      sendResponse({ ok: true });
      break;
    case 'cancel-job': {
      const j = jobs.get(msg.jobId);
      if (j) {
        j.cancelled = true;
        j.controller.abort();
      }
      sendResponse({ ok: true });
      break;
    }
    case 'revoke': {
      const u = blobUrls.get(msg.jobId);
      if (u) {
        URL.revokeObjectURL(u);
        blobUrls.delete(msg.jobId);
      }
      sendResponse({ ok: true });
      break;
    }
    case 'probe-video': {
      probeVideo(msg.url)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'parse-mpd': {
      try {
        const mpd = parseMPD(msg.text, msg.url);
        sendResponse({ ok: true, mpd });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      break;
    }
    default:
      sendResponse({ ok: true });
      break;
  }
});

async function probeVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.crossOrigin = 'anonymous';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
    };

    const done = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Probe failed'));
    };

    const timer = setTimeout(() => {
      if (v.duration && isFinite(v.duration)) {
        done({ duration: v.duration, width: v.videoWidth || 0, height: v.videoHeight || 0, thumbnail: '' });
      } else {
        fail();
      }
    }, 6500);

    v.addEventListener('error', fail, { once: true });
    v.addEventListener(
      'loadedmetadata',
      () => {
        const dur = isFinite(v.duration) ? v.duration : 0;
        if (!v.videoWidth || !v.videoHeight) {
          done({ duration: dur, width: 0, height: 0, thumbnail: '' });
          return;
        }
        const seekTo = dur > 2 ? Math.min(3, dur * 0.1) : 0.1;
        v.currentTime = seekTo;
      },
      { once: true }
    );

    v.addEventListener(
      'seeked',
      () => {
        let thumbnail = '';
        try {
          const w = 240;
          const h = Math.max(90, Math.round((v.videoHeight / v.videoWidth) * w));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(v, 0, 0, w, h);
          thumbnail = canvas.toDataURL('image/jpeg', 0.72);
        } catch {
          thumbnail = '';
        }
        done({
          duration: isFinite(v.duration) ? v.duration : 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          thumbnail,
        });
      },
      { once: true }
    );

    v.src = url;
  });
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Abgebrochen', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function fetchBuffer(url, range, signal, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const res = await fetch(url, { headers, signal, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new HttpError(res.status, url);
      const buf = await res.arrayBuffer();
      if (range && res.status === 200 && buf.byteLength > range.length) {
        return buf.slice(range.offset, range.offset + range.length);
      }
      return buf;
    } catch (e) {
      if (signal?.aborted) throw e;
      const fatal =
        e instanceof HttpError && e.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status);
      if (fatal || attempt >= tries) throw e;
      await sleep(400 * attempt * attempt, signal);
    }
  }
}

async function fetchText(url, signal) {
  const buf = await fetchBuffer(url, null, signal, 3);
  return new TextDecoder().decode(buf);
}

function makeDecryptor(signal) {
  const keys = new Map();
  const getKey = (url) => {
    if (!keys.has(url)) {
      const p = fetchBuffer(url, null, signal).then((raw) =>
        crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])
      );
      p.catch(() => keys.delete(url));
      keys.set(url, p);
    }
    return keys.get(url);
  };
  return async (data, key, iv, seq) => {
    const k = await getKey(key.url);
    let ivBytes = iv;
    if (!ivBytes) {
      ivBytes = new Uint8Array(16);
      const dv = new DataView(ivBytes.buffer);
      dv.setUint32(8, Math.floor(seq / 0x100000000));
      dv.setUint32(12, seq >>> 0);
    }
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, k, data);
  };
}

function mapHlsSegments(pl) {
  return pl.segments.map((s) => ({
    url: s.url,
    range: s.range,
    key: s.key,
    iv: s.iv,
    seq: s.seq,
    init: s.map,
  }));
}

async function resolveHlsMediaPlaylist(url, signal) {
  let pl = parseM3U8(await fetchText(url, signal), url);
  if (pl.type === 'master') {
    if (pl.drm) throw new Error('DRM-geschützt');
    const v = pl.variants[0];
    if (!v) throw new Error('Keine Varianten in der Playlist');
    pl = parseM3U8(await fetchText(v.url, signal), v.url);
  }
  if (pl.drm) throw new Error('DRM-geschützt');
  if (!pl.segments.length) throw new Error('Keine Segmente gefunden');
  return pl;
}

async function planHls(job, signal) {
  let videoUrl = job.url;
  let audioUrl = job.audioUrl || null;
  const mode = job.mode || 'both';

  // Falls Master-Playlist übergeben wurde
  const initialPl = parseM3U8(await fetchText(videoUrl, signal), videoUrl);
  let vPl;
  if (initialPl.type === 'master') {
    if (initialPl.drm) throw new Error('DRM-geschützt');
    if (mode === 'audio' && initialPl.audios?.length && initialPl.audios[0].url) {
      vPl = await resolveHlsMediaPlaylist(initialPl.audios[0].url, signal);
    } else {
      const v = initialPl.variants[job.variantIndex || 0] || initialPl.variants[0];
      if (!v) throw new Error('Keine Varianten in der Playlist');
      vPl = await resolveHlsMediaPlaylist(v.url, signal);
      if (mode === 'both' && !audioUrl && v.audioGroup) {
        const aTrack = (initialPl.audios || []).find((a) => a.groupId === v.audioGroup && a.url);
        if (aTrack) audioUrl = aTrack.url;
      }
    }
  } else {
    if (initialPl.drm) throw new Error('DRM-geschützt');
    if (!initialPl.segments.length) throw new Error('Keine Segmente gefunden');
    vPl = initialPl;
  }

  const first = vPl.segments[0];
  const isAudio = mode === 'audio';
  let ext = isAudio ? 'm4a' : 'mp4';
  let mime = isAudio ? 'audio/mp4' : 'video/mp4';

  if (first.map || /\.(m4s|mp4|m4v|m4a|cmfv|cmfa|fmp4)(\?|$)/i.test(first.url)) {
    ext = isAudio ? 'm4a' : 'mp4';
    mime = isAudio ? 'audio/mp4' : 'video/mp4';
  } else if (/\.aac(\?|$)/i.test(first.url)) {
    ext = 'aac';
    mime = 'audio/aac';
  } else if (/\.mp3(\?|$)/i.test(first.url)) {
    ext = 'mp3';
    mime = 'audio/mpeg';
  }

  let audioSegments = null;
  if (mode === 'both' && audioUrl) {
    try {
      const aPl = await resolveHlsMediaPlaylist(audioUrl, signal);
      if (aPl.segments?.length) {
        audioSegments = mapHlsSegments(aPl);
      }
    } catch {
      audioSegments = null;
    }
  }

  return {
    ext,
    mime,
    mode,
    segments: mapHlsSegments(vPl),
    audioSegments,
  };
}

function repToSegments(rep) {
  if (rep.single) {
    return [{ url: rep.single, range: null, init: null, isSingle: true }];
  }
  return rep.segments.map((s) => ({ url: s.url, range: s.range || null, init: rep.init }));
}

async function planDash(job, signal) {
  const mpd = parseMPD(await fetchText(job.url, signal), job.url);
  if (mpd.drm) throw new Error('DRM-geschützt');
  const mode = job.mode || (job.repKind === 'audio' ? 'audio' : 'both');

  if (mode === 'audio') {
    const aRep =
      mpd.audio.find((r) => r.index === job.repIndex && r.id === job.repId) ||
      mpd.audio[job.repIndex || 0] ||
      mpd.audio[0] ||
      mpd.video[0];
    if (!aRep) throw new Error('Keine Audiospur gefunden');
    const webm = /webm/i.test(aRep.mimeType);
    return {
      ext: webm ? 'weba' : 'm4a',
      mime: aRep.mimeType || 'audio/mp4',
      mode: 'audio',
      segments: repToSegments(aRep),
      audioSegments: null,
    };
  }

  const vRep =
    mpd.video.find((r) => r.index === job.repIndex && r.id === job.repId) ||
    mpd.video.find((r) => r.id === job.repId) ||
    mpd.video[job.repIndex || 0] ||
    mpd.video[0];
  if (!vRep) throw new Error('Keine Videospur gefunden');

  const vWebm = /webm/i.test(vRep.mimeType);
  const ext = vWebm ? 'webm' : 'mp4';
  const mime = vRep.mimeType || 'video/mp4';

  let audioSegments = null;
  if (mode === 'both' && mpd.audio.length) {
    // Bevorzuge passendes Containerformat (MP4-Audio zu MP4-Video)
    const aRep = mpd.audio.find((a) => /webm/i.test(a.mimeType) === vWebm) || mpd.audio[0];
    if (aRep) {
      audioSegments = repToSegments(aRep);
    }
  }

  return {
    ext,
    mime,
    mode,
    segments: repToSegments(vRep),
    audioSegments,
  };
}

async function planDirectFilter(job) {
  const mode = job.mode || 'both';
  const isAudio = mode === 'audio';
  return {
    ext: job.ext || (isAudio ? 'm4a' : 'mp4'),
    mime: isAudio ? 'audio/mp4' : 'video/mp4',
    mode,
    segments: [{ url: job.url, range: null, init: null, isSingle: true }],
    audioSegments: null,
  };
}

function makeReporter(jobId) {
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const patch = pending;
    pending = null;
    toBackground({ type: 'job-update', jobId, patch });
  };
  return (patch, immediate = false) => {
    pending = { ...(pending || {}), ...patch };
    if (immediate) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 300);
    }
  };
}

async function pool(count, concurrency, worker, signal) {
  let next = 0;
  const runner = async () => {
    while (next < count) {
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      const i = next++;
      await worker(i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, runner));
}

const initKey = (init) => (init ? `${init.url}|${init.range ? init.range.offset + '-' + init.range.length : ''}` : '');

async function runJob(job) {
  const state = { controller: new AbortController(), cancelled: false };
  jobs.set(job.id, state);
  const { signal } = state.controller;
  const report = makeReporter(job.id);

  try {
    report({ status: 'preparing' }, true);
    const plan =
      job.kind === 'dash'
        ? await planDash(job, signal)
        : job.kind === 'file-filter'
        ? await planDirectFilter(job)
        : await planHls(job, signal);

    const vSegs = plan.segments;
    const aSegs = plan.audioSegments || [];
    const total = vSegs.length + aSegs.length;
    report({ status: 'downloading', total, done: 0, bytes: 0 }, true);

    const decrypt = makeDecryptor(signal);
    let done = 0;
    let bytes = 0;

    // Init-Segmente laden (als ArrayBuffer für den Combiner)
    const vInitBufs = new Map();
    for (const seg of vSegs) {
      const k = initKey(seg.init);
      if (k && !vInitBufs.has(k)) {
        vInitBufs.set(k, await fetchBuffer(seg.init.url, seg.init.range, signal));
      }
    }
    const aInitBufs = new Map();
    for (const seg of aSegs) {
      const k = initKey(seg.init);
      if (k && !aInitBufs.has(k)) {
        aInitBufs.set(k, await fetchBuffer(seg.init.url, seg.init.range, signal));
      }
    }

    const vBuffers = new Array(vSegs.length);
    const aBuffers = new Array(aSegs.length);

    // Alle Segmente (Video + ggf. separates Audio) parallel laden
    const tasks = [
      ...vSegs.map((seg, idx) => ({ seg, idx, isAudio: false })),
      ...aSegs.map((seg, idx) => ({ seg, idx, isAudio: true })),
    ];

    await pool(
      tasks.length,
      job.concurrency || 6,
      async (tIdx) => {
        const { seg, idx, isAudio } = tasks[tIdx];
        let data = await fetchBuffer(seg.url, seg.range, signal);
        if (seg.key) data = await decrypt(data, seg.key, seg.iv, seg.seq);
        if (isAudio) aBuffers[idx] = data;
        else vBuffers[idx] = data;
        done++;
        bytes += data.byteLength;
        report({ done, bytes });
      },
      signal
    );

    report({ status: 'saving', done, bytes }, true);

    const firstVInit = vInitBufs.values().next().value || null;
    const firstAInit = aInitBufs.values().next().value || null;

    let finalBlob = null;

    // 1. Primärer Remuxer: Erzeugt eine standardkonforme, nicht-fragmentierte MP4-Datei (ftyp + moov + mdat)
    //    für fMP4 (HLS/DASH), MPEG-TS (H.264/AAC) und ADTS AAC.
    if (!/webm|weba/i.test(plan.ext || '') && !/webm/i.test(plan.mime || '')) {
      try {
        finalBlob = remuxStreamsToMp4({
          videoInitBuf: firstVInit,
          videoBuffers: vBuffers,
          audioInitBuf: firstAInit,
          audioBuffers: aBuffers,
          mode: plan.mode || 'both',
        });
        if (finalBlob) {
          plan.ext = plan.mode === 'audio' ? 'm4a' : 'mp4';
          plan.mime = plan.mode === 'audio' ? 'audio/mp4' : 'video/mp4';
        }
      } catch {
        finalBlob = null;
      }
    }

    // 2. Fallback für andere Formate / Container (z.B. WebM oder spezielle Streams)
    if (!finalBlob && aSegs.length > 0) {
      if ((firstVInit || vBuffers[0]) && (firstAInit || aBuffers[0])) {
        const combinedInit = buildCombinedInitSegment(firstVInit || vBuffers[0], firstAInit || aBuffers[0]);
        if (combinedInit) {
          const seqCounter = { value: 1 };
          const out = [combinedInit];
          const vLen = vBuffers.length;
          const aLen = aBuffers.length;
          const maxLen = Math.max(vLen, aLen);
          for (let i = 0; i < maxLen; i++) {
            if (i < vLen) out.push(rewriteFragmentSegment(vBuffers[i], 1, seqCounter));
            if (i < aLen) out.push(rewriteFragmentSegment(aBuffers[i], 2, seqCounter));
          }
          finalBlob = new Blob(out, { type: 'video/mp4' });
          plan.ext = 'mp4';
        }
      }
      if (!finalBlob && !firstVInit && !firstAInit) {
        const out = [];
        const ccState = { audioCc: 0 };
        const maxLen = Math.max(vBuffers.length, aBuffers.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < vBuffers.length && i < aBuffers.length) {
            out.push(mergeTsSegmentBuffers(vBuffers[i], aBuffers[i], ccState));
          } else if (i < vBuffers.length) {
            out.push(new Blob([vBuffers[i]]));
          } else if (i < aBuffers.length) {
            out.push(new Blob([aBuffers[i]]));
          }
        }
        finalBlob = new Blob(out, { type: plan.mime });
      }
    }

    if (!finalBlob) {
      // Einzelner Stream (oder bereits gemuxter Stream)
      const out = [];
      let lastInit = '';
      for (let i = 0; i < vSegs.length; i++) {
        const k = initKey(vSegs[i].init);
        if (k && k !== lastInit) {
          out.push(new Blob([vInitBufs.get(k)]));
          lastInit = k;
        }
        out.push(new Blob([vBuffers[i]]));
      }
      finalBlob = new Blob(out, { type: plan.mime });

      // Falls "Nur Video" oder "Nur Audio" bei einer kombinierten MP4-Datei gewählt wurde, Spur filtern
      if ((plan.mode === 'video' || plan.mode === 'audio') && out.length === 1 && vBuffers[0]) {
        finalBlob = filterMp4Tracks(vBuffers[0], plan.mode === 'audio' ? 'soun' : 'vide');
      }
    }

    const blobUrl = URL.createObjectURL(finalBlob);
    blobUrls.set(job.id, blobUrl);

    const finalExt = job.ext || plan.ext;
    const cleanStem = String(job.filename || 'Video').replace(/\.[a-z0-9]{2,5}$/i, '');

    await toBackground({
      type: 'job-blob-ready',
      jobId: job.id,
      blobUrl,
      filename: `${cleanStem}.${finalExt}`,
      size: finalBlob.size,
      saveAs: job.saveAs,
    });
  } catch (e) {
    state.controller.abort();
    if (state.cancelled) report({ status: 'cancelled' }, true);
    else report({ status: 'error', error: String(e?.message || e) }, true);
  } finally {
    jobs.delete(job.id);
  }
}
