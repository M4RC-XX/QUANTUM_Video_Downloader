// DASH (MPD) Parser – benötigt DOMParser (Popup / Offscreen-Dokument)
import { resolveUrl } from './util.js';

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

function parseIsoDuration(str) {
  if (!str) return 0;
  const m = String(str).trim().match(
    /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
  );
  if (!m) return 0;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => parseFloat(x) || 0);
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + s;
}

function parseRange(s) {
  if (!s) return null;
  const [a, b] = s.split('-').map(Number);
  if (!isFinite(a) || !isFinite(b)) return null;
  return { offset: a, length: b - a + 1 };
}

function baseOf(el, parentBase) {
  const b = kid(el, 'BaseURL');
  return b && b.textContent.trim() ? resolveUrl(b.textContent.trim(), parentBase) : parentBase;
}

export function parseMPD(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Kein gültiges MPD-Manifest');

  const live = mpd.getAttribute('type') === 'dynamic';
  const totalDur = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const drm = doc.getElementsByTagNameNS('*', 'ContentProtection').length > 0;
  const mpdBase = baseOf(mpd, mpdUrl);
  const periods = kids(mpd, 'Period');
  const period = periods[0];
  if (!period) throw new Error('MPD enthält keine Period');

  const periodDur =
    parseIsoDuration(period.getAttribute('duration')) ||
    Math.max(0, totalDur - parseIsoDuration(period.getAttribute('start'))) ||
    totalDur;
  const periodBase = baseOf(period, mpdBase);

  const video = [];
  const audio = [];

  for (const as of kids(period, 'AdaptationSet')) {
    const asBase = baseOf(as, periodBase);
    const asMime = as.getAttribute('mimeType') || '';
    const asType = as.getAttribute('contentType') || asMime.split('/')[0];
    const label = kid(as, 'Label')?.textContent.trim() || as.getAttribute('label') || '';

    for (const rep of kids(as, 'Representation')) {
      const mime = rep.getAttribute('mimeType') || asMime;
      const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
      let kind = asType || mime.split('/')[0];
      if (!kind) kind = /^(mp4a|ac-3|ec-3|opus|vorbis|flac)/i.test(codecs) ? 'audio' : 'video';
      if (kind !== 'video' && kind !== 'audio') continue;

      const repBase = baseOf(rep, asBase);
      const info = {
        id: rep.getAttribute('id') || '',
        bandwidth: +rep.getAttribute('bandwidth') || 0,
        width: +(rep.getAttribute('width') || as.getAttribute('width')) || 0,
        height: +(rep.getAttribute('height') || as.getAttribute('height')) || 0,
        codecs,
        mimeType: mime || (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
        lang: as.getAttribute('lang') || '',
        label,
      };
      Object.assign(info, buildSegments(rep, as, period, repBase, periodDur, info));
      (kind === 'video' ? video : audio).push(info);
    }
  }

  video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  video.forEach((r, i) => (r.index = i));
  audio.forEach((r, i) => (r.index = i));

  return { live, drm, duration: periodDur || totalDur, video, audio, multiPeriod: periods.length > 1 };
}

function buildSegments(rep, as, period, base, periodDur, info) {
  // 1) SegmentTemplate (vererbbar: Period > AdaptationSet > Representation)
  const tpls = [kid(period, 'SegmentTemplate'), kid(as, 'SegmentTemplate'), kid(rep, 'SegmentTemplate')].filter(Boolean);
  if (tpls.length) {
    const attr = (n) => {
      for (let i = tpls.length - 1; i >= 0; i--) {
        const v = tpls[i].getAttribute(n);
        if (v != null) return v;
      }
      return null;
    };
    let timeline = null;
    for (let i = tpls.length - 1; i >= 0 && !timeline; i--) timeline = kid(tpls[i], 'SegmentTimeline');

    const media = attr('media');
    const init = attr('initialization');
    const timescale = +attr('timescale') || 1;
    const startNumber = attr('startNumber') != null ? +attr('startNumber') : 1;
    const pto = +attr('presentationTimeOffset') || 0;

    const fill = (tpl, num, time) =>
      tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)d)?\$/g, (all, name, width) => {
        if (!name) return '$';
        if (name === 'RepresentationID') return info.id;
        let v = name === 'Number' ? num : name === 'Bandwidth' ? info.bandwidth : name === 'Time' ? time : 0;
        v = String(v);
        return width ? v.padStart(+width, '0') : v;
      });

    const segments = [];
    if (timeline && media) {
      const S = kids(timeline, 'S');
      const end = periodDur ? pto + periodDur * timescale : Infinity;
      let t = 0;
      let num = startNumber;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (s.getAttribute('t') != null) t = +s.getAttribute('t');
        const d = +s.getAttribute('d');
        if (!d) continue;
        let r = +(s.getAttribute('r') || 0);
        if (r < 0) {
          const nextT = S[i + 1]?.getAttribute('t');
          const limit = nextT != null ? +nextT : end;
          r = isFinite(limit) ? Math.max(0, Math.ceil((limit - t) / d) - 1) : 0;
        }
        for (let k = 0; k <= r; k++) {
          segments.push({ url: resolveUrl(fill(media, num, t), base) });
          t += d;
          num++;
        }
      }
    } else if (media) {
      const dur = +attr('duration');
      const count = dur && periodDur ? Math.ceil((periodDur * timescale) / dur) : 0;
      for (let k = 0; k < count; k++) {
        segments.push({ url: resolveUrl(fill(media, startNumber + k, pto + k * dur), base) });
      }
    }
    return {
      init: init ? { url: resolveUrl(fill(init, startNumber, 0), base), range: null } : null,
      segments,
      single: null,
    };
  }

  // 2) SegmentList
  const lists = [kid(as, 'SegmentList'), kid(rep, 'SegmentList')].filter(Boolean);
  if (lists.length) {
    const list = lists[lists.length - 1];
    const initEl = kid(list, 'Initialization') || kid(lists[0], 'Initialization');
    const segments = kids(list, 'SegmentURL').map((su) => ({
      url: su.getAttribute('media') ? resolveUrl(su.getAttribute('media'), base) : base,
      range: parseRange(su.getAttribute('mediaRange')),
    }));
    const init = initEl
      ? {
          url: initEl.getAttribute('sourceURL') ? resolveUrl(initEl.getAttribute('sourceURL'), base) : base,
          range: parseRange(initEl.getAttribute('range')),
        }
      : null;
    return { init, segments, single: null };
  }

  // 3) SegmentBase / nur BaseURL → komplette Datei
  return { init: null, segments: [], single: base };
}
