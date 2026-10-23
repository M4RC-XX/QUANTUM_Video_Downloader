// Standard-Konfiguration der Erweiterung (wird mit chrome.storage.sync abgeglichen).
// 'auto' nutzt automatisch chrome.i18n (Browsersprache mit Englisch als default_locale),
// kann vom Nutzer aber jederzeit in den Einstellungen auf eine feste Sprache umgestellt werden.
export const DEFAULT_SETTINGS = {
  language: 'auto',
  defaultDownloadMode: 'both',
  saveAs: false,
  clearOnNavigate: true,
  historyEnabled: true,
  maxHistoryEntries: 100,
  minSizeKB: 300,
  concurrency: 6,
};

// Zuordnung gängiger Audio-/Video-MIME-Typen zu Dateiendungen
const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/opus': 'opus',
};

export function extFromMime(mime) {
  return MIME_EXT[(mime || '').toLowerCase()] || '';
}

/**
 * Bereinigt einen String für die Verwendung als gültiger Dateiname unter Windows, macOS und Linux.
 * Entfernt Steuerzeichen, reservierte Sonderzeichen sowie ungültige Gerätenamen.
 */
export function sanitizeFilename(name, maxLen = 150) {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s || 'Video';
}

/**
 * Extrahiert aus einem Browser-Tab-Titel einen sauberen Basis-Dateinamen
 * (ohne vorangestellte Benachrichtigungszähler oder Plattform-Suffixe).
 */
export function cleanTabTitle(title) {
  let s = String(title || '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[-–|•]\s*(YouTube|Vimeo|Dailymotion|Twitch|TikTok|X|Twitter|Facebook|Instagram|Reddit)\s*$/i, '')
    .trim();
  return sanitizeFilename(s);
}

export function formatBytes(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 0)}${units[i]}`;
}

export function formatBytesDetailed(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatBandwidthRate(bps) {
  if (!bps || bps <= 0) return '';
  const bytesPerSec = bps / 8;
  if (bytesPerSec >= 1024 * 1024) {
    const mb = bytesPerSec / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')}MB/s`;
  }
  return `${Math.max(1, Math.round(bytesPerSec / 1024))}KB/s`;
}

export function formatBitrate(bps) {
  if (!bps) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbit/s`;
  return `${Math.round(bps / 1e3)} kbit/s`;
}

export function formatDuration(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function urlFileName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return '';
  }
}

export function urlHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function urlExt(url) {
  const m = urlFileName(url).match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

export function urlDir(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return '';
  }
}

export function stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

export function resolveUrl(rel, base) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

export function basename(path) {
  return String(path || '').split(/[\\/]/).pop();
}

/**
 * Prüft, ob eine Netzwerk-Domain zu YouTube bzw. dessen Video-CDN gehört.
 * Wird genutzt, um YouTube-Medienströme von der Download-Erfassung auszuschließen.
 */
export function isYouTubeHost(host) {
  return /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|youtube-nocookie\.com)$/i.test(host || '');
}

/**
 * Prüft, ob die übergebene Tab-URL selbst eine YouTube-Seite ist.
 * Nur wenn der aktive Tab direkt auf YouTube geöffnet ist, soll der Hinweis im Pop-Up erscheinen.
 */
export function isYouTubePage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Normalisiert eine YouTube-URL für den Seitenvergleich, sodass reine Hash- oder Zeitstempel-Änderungen
 * innerhalb desselben Videos die geschlossene Warnmeldung nicht erneut öffnen, ein Wechsel zu einem
 * anderen Video oder einer anderen Unterseite jedoch zuverlässig erkannt wird.
 */
export function normalizeYouTubeUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) return '';
    if (u.pathname === '/watch') {
      return `${u.origin}/watch?v=${u.searchParams.get('v') || ''}`;
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return '';
  }
}

export function getFavicon(pageUrl, favIconUrl) {
  if (favIconUrl && /^https?:|^data:/i.test(favIconUrl)) return favIconUrl;
  const host = urlHost(pageUrl);
  if (!host) return '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}
