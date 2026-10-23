// Minimaler, robuster HLS (M3U8) Parser – funktioniert ohne DOM (auch im Service Worker)
import { resolveUrl } from './util.js';

export function parseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function tagValue(line) {
  const i = line.indexOf(':');
  return i === -1 ? '' : line.slice(i + 1);
}

function tagName(line) {
  const i = line.indexOf(':');
  return i === -1 ? line : line.slice(0, i);
}

function parseByteRange(s) {
  const [len, off] = String(s).split('@');
  return { length: parseInt(len, 10), offset: off != null ? parseInt(off, 10) : null };
}

function hexToBytes(hex) {
  let h = hex.replace(/^0x/i, '');
  h = h.padStart(32, '0').slice(-32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// AES-128 (Standard-HLS-Verschlüsselung) ist kein DRM – alles andere schon.
function isDrmKey(a) {
  const method = (a.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return false;
  if (method !== 'AES-128') return true;
  const kf = a.KEYFORMAT;
  return !!kf && kf !== 'identity';
}

export function parseM3U8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Keine gültige M3U8-Playlist');
  }
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, base) {
  const variants = [];
  const audios = [];
  const subtitles = [];
  const otherUrls = [];
  let drm = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tag = tagName(l);
    if (tag === '#EXT-X-STREAM-INF') {
      const a = parseAttributes(tagValue(l));
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { uri = lines[j]; i = j; break; }
      }
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      const codecs = a.CODECS || '';
      const resolvedUrl = resolveUrl(uri, base);
      const isAudioOnlyStreamInf =
        !w &&
        !h &&
        codecs &&
        /(mp4a|ac-3|ec-3|opus|vorbis|flac)/i.test(codecs) &&
        !/(avc1|hev1|hvc1|vp09|vp9|av01|mp4v)/i.test(codecs);

      if (isAudioOnlyStreamInf) {
        audios.push({
          type: 'AUDIO',
          groupId: a.AUDIO || '',
          name: 'Audio',
          language: '',
          url: resolvedUrl,
          isDefault: false,
        });
      } else {
        variants.push({
          url: resolvedUrl,
          bandwidth: +(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
          width: w || 0,
          height: h || 0,
          codecs,
          frameRate: +(a['FRAME-RATE'] || 0),
          audioGroup: a.AUDIO || null,
        });
      }
    } else if (tag === '#EXT-X-MEDIA') {
      const a = parseAttributes(tagValue(l));
      const r = {
        type: a.TYPE,
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || a.LANGUAGE || 'Audio',
        language: a.LANGUAGE || '',
        url: a.URI ? resolveUrl(a.URI, base) : null,
        isDefault: a.DEFAULT === 'YES',
      };
      if (a.TYPE === 'AUDIO') audios.push(r);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(r);
      else if (r.url) otherUrls.push(r.url);
    } else if (tag === '#EXT-X-I-FRAME-STREAM-INF') {
      const a = parseAttributes(tagValue(l));
      if (a.URI) otherUrls.push(resolveUrl(a.URI, base));
    } else if (tag === '#EXT-X-SESSION-KEY') {
      if (isDrmKey(parseAttributes(tagValue(l)))) drm = true;
    }
  }

  // Doppelte Varianten (gleiche URL) entfernen, nach Qualität sortieren
  const seen = new Set();
  const unique = variants.filter((v) => !seen.has(v.url) && seen.add(v.url));
  unique.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audios.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));

  return { type: 'master', variants: unique, audios, subtitles, otherUrls, drm };
}

function parseMedia(lines, base) {
  let seq = 0;
  let key = null;
  let map = null;
  let dur = 0;
  let range = null;
  let drm = false;
  let endList = false;
  let playlistType = '';
  let total = 0;
  const lastEnd = {};
  const segments = [];

  for (const l of lines) {
    if (l.startsWith('#')) {
      const tag = tagName(l);
      const val = tagValue(l);
      switch (tag) {
        case '#EXT-X-MEDIA-SEQUENCE': seq = parseInt(val, 10) || 0; break;
        case '#EXT-X-PLAYLIST-TYPE': playlistType = val.trim().toUpperCase(); break;
        case '#EXT-X-ENDLIST': endList = true; break;
        case '#EXTINF': dur = parseFloat(val) || 0; break;
        case '#EXT-X-BYTERANGE': range = parseByteRange(val); break;
        case '#EXT-X-KEY': {
          const a = parseAttributes(val);
          const method = (a.METHOD || 'NONE').toUpperCase();
          if (method === 'NONE') key = null;
          else if (isDrmKey(a)) { drm = true; key = null; }
          else key = { method, url: resolveUrl(a.URI, base), iv: a.IV ? hexToBytes(a.IV) : null };
          break;
        }
        case '#EXT-X-MAP': {
          const a = parseAttributes(val);
          let r = null;
          if (a.BYTERANGE) {
            r = parseByteRange(a.BYTERANGE);
            if (r.offset == null) r.offset = 0;
          }
          map = { url: resolveUrl(a.URI, base), range: r };
          break;
        }
        default: break;
      }
      continue;
    }

    const url = resolveUrl(l, base);
    let r = null;
    if (range) {
      const off = range.offset != null ? range.offset : (lastEnd[url] || 0);
      r = { offset: off, length: range.length };
      lastEnd[url] = off + range.length;
      range = null;
    }
    segments.push({
      url,
      duration: dur,
      key,
      iv: key ? key.iv : null,
      seq: seq + segments.length,
      map,
      range: r,
    });
    total += dur;
    dur = 0;
  }

  return {
    type: 'media',
    segments,
    duration: total,
    endList: endList || playlistType === 'VOD',
    drm,
    encrypted: segments.some((s) => s.key),
    hasMap: segments.some((s) => s.map),
  };
}
