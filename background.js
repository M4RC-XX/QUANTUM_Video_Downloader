import { parseM3U8 } from './lib/hls.js';
import { createTranslator } from './lib/i18n.js';
import {
  DEFAULT_SETTINGS,
  urlExt,
  urlDir,
  urlHost,
  urlFileName,
  stripExt,
  extFromMime,
  cleanTabTitle,
  formatBandwidthRate,
  formatBytes,
  isYouTubeHost,
  isYouTubePage,
  normalizeYouTubeUrl,
  getFavicon,
  basename,
} from './lib/util.js';

// ---------------------------------------------------------------------------
// Benutzereinstellungen (synchronisiert über chrome.storage.sync)
// ---------------------------------------------------------------------------
let settings = { ...DEFAULT_SETTINGS };
const settingsReady = chrome.storage.sync
  .get(DEFAULT_SETTINGS)
  .then((s) => {
    settings = { ...DEFAULT_SETTINGS, ...s };
    scheduleContextMenuRebuild();
  })
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (newValue !== undefined) settings[k] = newValue;
  }
  if (changes.maxHistoryEntries) enforceHistoryLimit();
  if (changes.language) scheduleContextMenuRebuild();
});

try {
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
} catch {
  // Ältere Chromium-Versionen ohne setBadgeTextColor-Unterstützung ignorieren
}

// ---------------------------------------------------------------------------
// Klassifizierung eingehender Medien- und Stream-Antworten
// ---------------------------------------------------------------------------
const FILE_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'f4v', 'ogv', '3gp', 'avi', 'wmv',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba',
]);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'm4v_seg', 'vtt', 'webvtt']);
const HLS_MIME = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);
const SEGMENT_NAME = /(^|[-_./])(seg|segment|chunk|frag|fragment|part|init)[-_]?\d*[-_.]/i;
const MAX_ITEMS = 120;

/**
 * Ordnet anhand von Content-Type und Dateiendung zu, ob es sich um einen
 * HLS-Stream (M3U8), einen DASH-Stream (MPD) oder eine direkte Mediendatei handelt.
 * Einzelne Stream-Segmente (.ts, .m4s) werden herausgefiltert.
 */
function classify(ct, ext) {
  if (HLS_MIME.has(ct) || ext === 'm3u8') return 'hls';
  if (ct === 'application/dash+xml' || ext === 'mpd') return 'dash';
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || ct === 'audio/mp2t' || SEGMENT_EXT.has(ext)) return null;
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'file';
  if (
    FILE_EXT.has(ext) &&
    (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream' || ct.startsWith('application/x-'))
  ) {
    return 'file';
  }
  return null;
}

function headerMap(headers = []) {
  const map = {};
  for (const h of headers) map[h.name.toLowerCase()] = h.value || '';
  return map;
}

/**
 * Ermittelt die Gesamtgröße einer Mediendatei.
 * Bei HTTP 206 Partial Content wird die Gesamtgröße aus dem Content-Range-Header gelesen.
 */
function totalSize(details, h) {
  const cr = h['content-range'];
  if (cr) {
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return +m[1];
  }
  if (details.statusCode === 200 && h['content-length']) return +h['content-length'] || 0;
  return 0;
}

// Navigations-Generation pro Tab, damit verspätete asynchrone Antworten nach einem Seitenwechsel verworfen werden
const navGen = new Map();
const pendingUrls = new Set();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      onHeaders(details);
    } catch (e) {
      console.warn('[QUANTUM] onHeaders', e);
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

function onHeaders(details) {
  if (details.tabId < 0) return;
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  const url = details.url;
  if (!/^https?:/i.test(url)) return;

  const tabId = details.tabId;
  const host = urlHost(url);

  // YouTube-Medienströme dürfen gemäß Chrome Web Store Richtlinien nicht heruntergeladen werden
  if (isYouTubeHost(host)) {
    syncYouTubeTabState(tabId);
    return;
  }

  const h = headerMap(details.responseHeaders);
  const ct = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = urlExt(url);
  const kind = classify(ct, ext);
  if (!kind) return;

  const gen = navGen.get(tabId) || 0;

  if (kind === 'file') {
    handleFile(tabId, url, ct, totalSize(details, h), details.initiator, gen);
  } else if (kind === 'hls') {
    handleHls(tabId, url, details.initiator, gen);
  } else if (kind === 'dash') {
    handleDash(tabId, url, details.initiator, gen);
  }
}

/**
 * Aktualisiert den YouTube-Status eines Tabs anhand seiner tatsächlichen Tab-URL.
 * Der Hinweis wird nur aktiviert, wenn der Tab selbst auf YouTube geöffnet ist.
 * Wechselt die URL innerhalb von YouTube (z.B. neues Video), wird eine zuvor geschlossene
 * Warnung automatisch wieder eingeblendet.
 */
async function syncYouTubeTabState(tabId, explicitUrl = null) {
  try {
    let tabUrl = explicitUrl;
    if (!tabUrl) {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || '';
    }
    const onYouTube = isYouTubePage(tabUrl);
    const normUrl = normalizeYouTubeUrl(tabUrl);

    await withTab(tabId, (data) => {
      if (!onYouTube) {
        if (!data.youtube && !data.youtubeDismissed && !data.youtubeUrl) return false;
        data.youtube = false;
        data.youtubeDismissed = false;
        data.youtubeDismissedUrl = '';
        data.youtubeUrl = '';
        return true;
      }

      let changed = false;
      if (!data.youtube) {
        data.youtube = true;
        changed = true;
      }
      if (normUrl && data.youtubeUrl !== normUrl) {
        data.youtubeUrl = normUrl;
        // Bei Seitenwechsel auf YouTube die Schließung zurücksetzen
        if (data.youtubeDismissed && data.youtubeDismissedUrl !== normUrl) {
          data.youtubeDismissed = false;
          data.youtubeDismissedUrl = '';
        }
        changed = true;
      }
      return changed;
    });
  } catch {
    // Tab wurde zwischenzeitlich geschlossen
  }
}

async function pageInfo(tabId, initiator, mediaUrl) {
  let referer = initiator || '';
  let pageUrl = initiator || mediaUrl || '';
  let pageTitle = '';
  let favIconUrl = '';
  let tabUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url || '';
    referer = tabUrl || initiator || '';
    pageUrl = tabUrl || pageUrl;
    pageTitle = cleanTabTitle(tab.title || '');
    favIconUrl = getFavicon(pageUrl, tab.favIconUrl);
  } catch {
    favIconUrl = getFavicon(pageUrl, '');
  }
  const domain = urlHost(pageUrl) || urlHost(mediaUrl);
  if (!pageTitle) {
    pageTitle = cleanTabTitle(stripExt(urlFileName(mediaUrl)) || domain || 'Video');
  }
  return { referer, pageUrl, tabUrl, domain, pageTitle, favIconUrl };
}

async function handleFile(tabId, url, mime, size, initiator, gen) {
  await settingsReady;
  if (size && size < settings.minSizeKB * 1024) return;
  if (SEGMENT_NAME.test(url.split('?')[0]) && size && size < 20 * 1024 * 1024) return;
  const info = await pageInfo(tabId, initiator, url);
  if (isYouTubePage(info.tabUrl) || isYouTubeHost(info.domain) || isYouTubeHost(urlHost(url))) {
    syncYouTubeTabState(tabId, info.tabUrl);
    return;
  }

  const e = urlExt(url);
  const ext = FILE_EXT.has(e) ? e : extFromMime(mime) || 'mp4';
  const isAudio = (mime || '').startsWith('audio/') || ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'].includes(ext);

  let createdId = null;
  await withTab(tabId, (data) => {
    if ((navGen.get(tabId) || 0) !== gen) return false;
    const existing = data.items.find((i) => i.url === url);
    if (existing) {
      if (size > (existing.size || 0)) {
        existing.size = size;
        return true;
      }
      return false;
    }
    const dir = urlDir(url);
    if (data.items.some((i) => i.kind !== 'file' && urlDir(i.url) === dir)) return false;

    const meta = data.pageMeta || {};
    createdId = crypto.randomUUID();
    data.items.push({
      id: createdId,
      kind: 'file',
      url,
      mime,
      ext,
      isAudio,
      size,
      ...info,
      thumbnail: meta.thumbnail || '',
      duration: meta.duration || 0,
      width: meta.width || 0,
      height: meta.height || 0,
      detectedAt: Date.now(),
    });
  });

  if (createdId && !isAudio) {
    probeVideoMetadata(tabId, createdId, url, info.referer, gen);
  }
}

/**
 * Ermittelt für direkte Videodateien im Offscreen-Dokument Dauer, Auflösung und ein Vorschaubild,
 * falls diese Angaben noch nicht über das Content-Script aus dem DOM gelesen werden konnten.
 */
async function probeVideoMetadata(tabId, itemId, url, referer, gen) {
  const cur = await readTab(tabId);
  const target = cur.items.find((i) => i.id === itemId);
  if (!target || (target.thumbnail && target.duration && target.height)) return;

  const ruleId = await addRefererRule(referer, { ...extensionInitiator(), requestDomains: [urlHost(url)] });
  try {
    await ensureOffscreen();
    const res = await sendOffscreen({ type: 'probe-video', url });
    if (res && res.ok) {
      await withTab(tabId, (data) => {
        if ((navGen.get(tabId) || 0) !== gen) return false;
        const item = data.items.find((i) => i.id === itemId);
        if (!item) return false;
        if (res.duration && !item.duration) item.duration = res.duration;
        if (res.width && !item.width) item.width = res.width;
        if (res.height && !item.height) item.height = res.height;
        if (res.thumbnail && !item.thumbnail) item.thumbnail = res.thumbnail;
      });
    }
  } catch {
    // Metadaten-Ermittlung ist optional; Fehler beim Probing stillschweigend übergehen
  } finally {
    removeRule(ruleId);
    maybeCloseOffscreen();
  }
}

async function handleHls(tabId, url, initiator, gen) {
  const key = tabId + '|' + url;
  if (pendingUrls.has(key)) return;
  const cur = await readTab(tabId);
  if (cur.items.some((i) => i.url === url) || cur.children.includes(url)) return;
  pendingUrls.add(key);

  const info = await pageInfo(tabId, initiator, url);
  if (isYouTubePage(info.tabUrl) || isYouTubeHost(info.domain) || isYouTubeHost(urlHost(url))) {
    pendingUrls.delete(key);
    syncYouTubeTabState(tabId, info.tabUrl);
    return;
  }

  const item = {
    id: crypto.randomUUID(),
    kind: 'hls',
    url,
    ext: 'mp4',
    ...info,
    detectedAt: Date.now(),
  };
  let children = [];
  try {
    const pl = parseM3U8(await fetchText(url, info.referer), url);
    if (pl.type === 'master') {
      item.master = true;
      item.variants = pl.variants.map((v, idx) => ({
        index: idx,
        url: v.url,
        ext: 'mp4',
        format: 'MP4',
        width: v.width || 0,
        height: v.height || 0,
        bandwidth: v.bandwidth || 0,
        codecs: v.codecs || '',
        audioGroup: v.audioGroup || null,
      }));
      item.audios = pl.audios.filter((a) => a.url);
      item.drm = pl.drm;
      children = [
        ...pl.variants.map((v) => v.url),
        ...pl.audios.map((a) => a.url),
        ...pl.subtitles.map((s) => s.url),
        ...pl.otherUrls,
      ].filter(Boolean);
      const first = pl.variants[0];
      if (first) {
        try {
          const sub = parseM3U8(await fetchText(first.url, info.referer), first.url);
          if (sub.type === 'media') {
            item.duration = sub.duration;
            item.live = !sub.endList;
            item.drm = item.drm || sub.drm;
            item.encrypted = sub.encrypted;
          }
        } catch {
          // Unter-Playlist konnte nicht vorab geladen werden
        }
      }
    } else {
      item.master = false;
      item.duration = pl.duration;
      item.live = !pl.endList;
      item.drm = pl.drm;
      item.encrypted = pl.encrypted;
      item.segmentCount = pl.segments.length;
      if (!pl.segments.length) {
        pendingUrls.delete(key);
        return;
      }
      const firstSegUrl = pl.segments[0]?.url || '';
      const firstInitUrl = pl.segments[0]?.map?.url || '';
      if (
        /\.(aac|mp3|m4a|weba|ogg|opus)(\?|$)/i.test(firstSegUrl) ||
        /\.(m4a|aac)(\?|$)/i.test(firstInitUrl) ||
        /(^|[/_.-])(audio|sound|aac|mp4a)([/_.-]|$)/i.test(url.split('?')[0])
      ) {
        item.isAudioPlaylist = true;
      }
    }
  } catch (e) {
    item.parseError = String(e?.message || e);
  } finally {
    pendingUrls.delete(key);
  }

  const stripQuery = (u) => String(u || '').split('?')[0];

  await withTab(tabId, (data) => {
    if ((navGen.get(tabId) || 0) !== gen) return false;
    const baseNoQuery = stripQuery(url);
    if (
      data.items.some((i) => stripQuery(i.url) === baseNoQuery) ||
      data.children.some((c) => stripQuery(c) === baseNoQuery)
    ) {
      return false;
    }

    if (item.master) {
      if (children.length) {
        const childBaseSet = new Set(children.map(stripQuery));
        data.children.push(...children);
        data.items = data.items.filter((i) => !childBaseSet.has(stripQuery(i.url)));
      }
      // Vorher erkannte Einzel-Playlists derselben Stream-Domain bereinigen, da die Master-Playlist alle Varianten bündelt
      const host = urlHost(url);
      data.items = data.items.filter((i) => !(i.kind === 'hls' && !i.master && urlHost(i.url) === host));
    } else {
      // Falls bereits eine Master-Playlist auf diesem Tab existiert, keine einzelnen Unter-Playlists doppelt auflisten
      const existingMaster = data.items.find((i) => i.kind === 'hls' && i.master && urlHost(i.url) === urlHost(url));
      if (existingMaster) {
        if (item.isAudioPlaylist) {
          existingMaster.audios = existingMaster.audios || [];
          if (!existingMaster.audios.some((a) => stripQuery(a.url) === baseNoQuery)) {
            existingMaster.audios.push({ type: 'AUDIO', groupId: '', name: 'Audio', url, isDefault: true });
          }
        }
        return true;
      }

      // Separate Audio-Playlist mit zugehöriger Video-Playlist verknüpfen
      if (item.isAudioPlaylist) {
        const existingVideoHls = data.items.find((i) => i.kind === 'hls' && !i.isAudioPlaylist);
        if (existingVideoHls) {
          existingVideoHls.audios = existingVideoHls.audios || [];
          if (!existingVideoHls.audios.some((a) => stripQuery(a.url) === baseNoQuery)) {
            existingVideoHls.audios.push({ type: 'AUDIO', groupId: '', name: 'Audio', url, isDefault: true });
          }
          return true;
        }
      } else {
        // Falls zuerst die Audio-Playlist erkannt wurde und danach die Video-Playlist folgt: zusammenführen
        const orphanAudioIdx = data.items.findIndex((i) => i.kind === 'hls' && !i.master && i.isAudioPlaylist);
        if (orphanAudioIdx !== -1) {
          const orphanAudio = data.items[orphanAudioIdx];
          data.items.splice(orphanAudioIdx, 1);
          item.audios = item.audios || [];
          item.audios.push({ type: 'AUDIO', groupId: '', name: 'Audio', url: orphanAudio.url, isDefault: true });
        }
      }
    }

    const dir = urlDir(url);
    data.items = data.items.filter((i) => !(i.kind === 'file' && urlDir(i.url) === dir));
    const meta = data.pageMeta || {};
    if (!item.thumbnail && meta.thumbnail) item.thumbnail = meta.thumbnail;
    if (!item.duration && meta.duration) item.duration = meta.duration;
    data.items.push(item);
  });
}

async function handleDash(tabId, url, initiator, gen) {
  const key = tabId + '|' + url;
  if (pendingUrls.has(key)) return;
  const cur = await readTab(tabId);
  if (cur.items.some((i) => i.url === url)) return;
  pendingUrls.add(key);

  const info = await pageInfo(tabId, initiator, url);
  if (isYouTubePage(info.tabUrl) || isYouTubeHost(info.domain) || isYouTubeHost(urlHost(url))) {
    pendingUrls.delete(key);
    syncYouTubeTabState(tabId, info.tabUrl);
    return;
  }

  const item = {
    id: crypto.randomUUID(),
    kind: 'dash',
    url,
    ext: 'mp4',
    ...info,
    detectedAt: Date.now(),
  };

  try {
    const text = await fetchText(url, info.referer);
    await ensureOffscreen();
    const res = await sendOffscreen({ type: 'parse-mpd', text, url });
    if (res && res.ok && res.mpd) {
      const mpd = res.mpd;
      item.duration = mpd.duration || 0;
      item.live = !!mpd.live;
      item.drm = !!mpd.drm;
      item.variants = (mpd.video || []).map((v, idx) => {
        const webm = /webm/i.test(v.mimeType);
        return {
          index: idx,
          repIndex: v.index,
          repId: v.id,
          single: v.single || null,
          ext: webm ? 'webm' : 'mp4',
          format: webm ? 'WEBM' : 'MP4',
          width: v.width || 0,
          height: v.height || 0,
          bandwidth: v.bandwidth || 0,
          codecs: v.codecs || '',
          mimeType: v.mimeType || 'video/mp4',
        };
      });
      item.dashAudios = (mpd.audio || []).map((a, idx) => {
        const webm = /webm/i.test(a.mimeType);
        return {
          index: idx,
          repIndex: a.index,
          repId: a.id,
          single: a.single || null,
          ext: webm ? 'weba' : 'm4a',
          format: webm ? 'WEBA' : 'M4A',
          bandwidth: a.bandwidth || 0,
          lang: a.lang || '',
          label: a.label || a.lang || 'Audio',
          mimeType: a.mimeType || 'audio/mp4',
        };
      });
    }
  } catch (e) {
    item.parseError = String(e?.message || e);
  } finally {
    pendingUrls.delete(key);
    maybeCloseOffscreen();
  }

  await withTab(tabId, (data) => {
    if ((navGen.get(tabId) || 0) !== gen) return false;
    if (data.items.some((i) => i.url === url)) return false;
    const dir = urlDir(url);
    data.items = data.items.filter((i) => !(i.kind === 'file' && urlDir(i.url) === dir));
    const meta = data.pageMeta || {};
    if (!item.thumbnail && meta.thumbnail) item.thumbnail = meta.thumbnail;
    if (!item.duration && meta.duration) item.duration = meta.duration;
    data.items.push(item);
  });
}

// ---------------------------------------------------------------------------
// Sitzungsspeicher je Tab (chrome.storage.session) mit serieller Sperre
// ---------------------------------------------------------------------------
const tabLocks = new Map();

async function readTab(tabId) {
  const key = 'tab_' + tabId;
  const data = (await chrome.storage.session.get(key))[key];
  return (
    data || {
      items: [],
      children: [],
      youtube: false,
      youtubeDismissed: false,
      youtubeDismissedUrl: '',
      youtubeUrl: '',
      pageMeta: {},
    }
  );
}

function withTab(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev
    .then(async () => {
      const data = await readTab(tabId);
      const res = await fn(data);
      if (res === false) return;
      if (data.items.length > MAX_ITEMS) data.items = data.items.slice(-MAX_ITEMS);
      await chrome.storage.session.set({ ['tab_' + tabId]: data });
      updateBadge(tabId, data);
      scheduleContextMenuRebuild();
    })
    .catch((e) => console.warn('[QUANTUM] withTab', e));
  tabLocks.set(tabId, next);
  return next;
}

function clearTab(tabId) {
  navGen.set(tabId, (navGen.get(tabId) || 0) + 1);
  return withTab(tabId, (data) => {
    data.items = [];
    data.children = [];
    data.youtube = false;
    data.youtubeDismissed = false;
    data.youtubeDismissedUrl = '';
    data.youtubeUrl = '';
    data.pageMeta = {};
  });
}

function updateBadge(tabId, data) {
  const count = data.items?.length || 0;
  const text = count ? String(count) : data.youtube && !data.youtubeDismissed ? '!' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await settingsReady;
  if (settings.clearOnNavigate) {
    await clearTab(d.tabId);
  } else {
    const data = await readTab(d.tabId);
    updateBadge(d.tabId, data);
  }
  await syncYouTubeTabState(d.tabId, d.url || '');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // Auch bei Single-Page-Navigationen (wie auf YouTube) den YouTube-Status und die Schließung aktualisieren
    syncYouTubeTabState(tabId, changeInfo.url);
  }
  if (changeInfo.title && tab?.title) {
    const clean = cleanTabTitle(tab.title);
    if (clean) {
      withTab(tabId, (data) => {
        let changed = false;
        for (const item of data.items) {
          if (!item.customName && item.pageTitle !== clean) {
            item.pageTitle = clean;
            changed = true;
          }
        }
        return changed;
      });
    }
  }
});

chrome.tabs.onActivated.addListener(() => {
  scheduleContextMenuRebuild();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navGen.delete(tabId);
  tabLocks.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId);
});

// ---------------------------------------------------------------------------
// Dynamisches Browser-Kontextmenü (serialisiert über Promise-Queue)
// ---------------------------------------------------------------------------
const menuActions = new Map();
let menuTimer = null;
let menuRebuildLock = Promise.resolve();

function createMenuItem(props) {
  chrome.contextMenus.create(props, () => {
    // Etwaige Laufzeitfehler (z.B. bei schnellem Tab-Wechsel) abfangen, damit Chrome keine Warnung protokolliert
    void chrome.runtime.lastError;
  });
}

function scheduleContextMenuRebuild() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    menuRebuildLock = menuRebuildLock.then(() => rebuildContextMenu()).catch(() => {});
  }, 150);
}

async function rebuildContextMenu() {
  await settingsReady;
  const t = createTranslator(settings.language);
  menuActions.clear();

  await new Promise((resolve) =>
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    })
  );

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabData = activeTab ? await readTab(activeTab.id) : { items: [], youtube: false };
  const items = tabData.items || [];
  const activeTabIsYouTube = Boolean(activeTab?.url && isYouTubePage(activeTab.url));

  const rootTitle = items.length ? `${t('appName')} (${items.length})` : t('appName');
  createMenuItem({
    id: 'quantum_root',
    title: rootTitle,
    contexts: ['page', 'video', 'audio', 'frame'],
  });

  if (activeTabIsYouTube) {
    createMenuItem({
      id: 'quantum_yt_notice',
      parentId: 'quantum_root',
      title: `⚠ ${t('ctxYoutube')}`,
      enabled: false,
      contexts: ['page', 'video', 'audio', 'frame'],
    });
  }

  if (!items.length) {
    createMenuItem({
      id: 'quantum_empty',
      parentId: 'quantum_root',
      title: t('ctxNoMedia'),
      enabled: false,
      contexts: ['page', 'video', 'audio', 'frame'],
    });
  } else {
    const shown = [...items].reverse().slice(0, 12);
    shown.forEach((item, idx) => {
      const itemMenuId = `quantum_item_${idx}`;
      const badge = item.kind === 'file' ? (item.ext || 'MP4').toUpperCase() : item.kind.toUpperCase();
      const baseName = item.customName || item.pageTitle || 'Video';
      const sizeStr = item.size ? ` (${formatBytes(item.size)})` : '';
      createMenuItem({
        id: itemMenuId,
        parentId: 'quantum_root',
        title: `[${badge}] ${baseName}${sizeStr}`,
        contexts: ['page', 'video', 'audio', 'frame'],
      });

      if (item.variants?.length) {
        item.variants.slice(0, 8).forEach((v, vIdx) => {
          const qId = `${itemMenuId}_v_${vIdx}`;
          const res = v.width && v.height ? `${v.width}x${v.height}` : v.height ? `${v.height}p` : 'Standard';
          const rate = formatBandwidthRate(v.bandwidth);
          const label = [v.format || 'MP4', res, rate].filter(Boolean).join(' - ');
          createMenuItem({
            id: qId,
            parentId: itemMenuId,
            title: `⬇ ${label}`,
            contexts: ['page', 'video', 'audio', 'frame'],
          });
          menuActions.set(qId, () =>
            triggerItemDownload(item, {
              variantIndex: vIdx,
              mode: settings.defaultDownloadMode || 'both',
              saveAs: settings.saveAs,
            })
          );
        });

        createMenuItem({
          id: `${itemMenuId}_sep1`,
          parentId: itemMenuId,
          type: 'separator',
          contexts: ['page', 'video', 'audio', 'frame'],
        });
      }

      const modeBothId = `${itemMenuId}_both`;
      createMenuItem({
        id: modeBothId,
        parentId: itemMenuId,
        title: t('modeBoth'),
        contexts: ['page', 'video', 'audio', 'frame'],
      });
      menuActions.set(modeBothId, () =>
        triggerItemDownload(item, { variantIndex: 0, mode: 'both', saveAs: settings.saveAs })
      );

      const modeVideoId = `${itemMenuId}_video`;
      createMenuItem({
        id: modeVideoId,
        parentId: itemMenuId,
        title: t('modeVideo'),
        contexts: ['page', 'video', 'audio', 'frame'],
      });
      menuActions.set(modeVideoId, () =>
        triggerItemDownload(item, { variantIndex: 0, mode: 'video', saveAs: settings.saveAs })
      );

      const modeAudioId = `${itemMenuId}_audio`;
      createMenuItem({
        id: modeAudioId,
        parentId: itemMenuId,
        title: t('modeAudio'),
        contexts: ['page', 'video', 'audio', 'frame'],
      });
      menuActions.set(modeAudioId, () =>
        triggerItemDownload(item, { variantIndex: 0, mode: 'audio', saveAs: settings.saveAs })
      );

      const saveAsId = `${itemMenuId}_saveas`;
      createMenuItem({
        id: saveAsId,
        parentId: itemMenuId,
        title: t('downloadAs'),
        contexts: ['page', 'video', 'audio', 'frame'],
      });
      menuActions.set(saveAsId, () =>
        triggerItemDownload(item, {
          variantIndex: 0,
          mode: settings.defaultDownloadMode || 'both',
          saveAs: true,
        })
      );
    });
  }

  createMenuItem({
    id: 'quantum_sep_bottom',
    parentId: 'quantum_root',
    type: 'separator',
    contexts: ['page', 'video', 'audio', 'frame'],
  });

  createMenuItem({
    id: 'quantum_open_history',
    parentId: 'quantum_root',
    title: t('ctxOpenHistory'),
    contexts: ['page', 'video', 'audio', 'frame'],
  });
  menuActions.set('quantum_open_history', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
  });

  if (items.length && activeTab) {
    createMenuItem({
      id: 'quantum_clear_tab',
      parentId: 'quantum_root',
      title: t('ctxClearList'),
      contexts: ['page', 'video', 'audio', 'frame'],
    });
    menuActions.set('quantum_clear_tab', () => clearTab(activeTab.id));
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  const fn = menuActions.get(info.menuItemId);
  if (fn) fn();
});

async function triggerItemDownload(item, { variantIndex = 0, mode = 'both', customExt = null, saveAs = false } = {}) {
  const stem = cleanTabTitle(item.customName || item.pageTitle || 'Video');
  const commonMeta = {
    title: stem,
    referer: item.referer,
    pageUrl: item.pageUrl || item.referer,
    domain: item.domain || urlHost(item.pageUrl || item.url),
    favIconUrl: item.favIconUrl,
    thumbnail: item.thumbnail || '',
    saveAs,
  };

  if (item.kind === 'file') {
    const baseExt = (item.ext || 'mp4').toLowerCase();
    const ext = customExt || (mode === 'audio' && !item.isAudio ? 'm4a' : baseExt);
    if ((mode === 'video' || mode === 'audio') && !item.isAudio && /^(mp4|m4v|mov)$/i.test(baseExt)) {
      return startSegmentJob({
        ...commonMeta,
        kind: 'file-filter',
        mode,
        url: item.url,
        filename: stem,
        ext,
        label: mode === 'audio' ? 'AUDIO' : ext.toUpperCase(),
        mediaType: mode === 'audio' ? 'audio' : 'video',
      });
    }
    return startDirectDownload({
      ...commonMeta,
      url: item.url,
      filename: `${stem}.${ext}`,
      label: ext.toUpperCase(),
      mediaType: mode === 'audio' ? 'audio' : 'video',
    });
  }

  if (item.kind === 'hls') {
    const variants = item.variants || [];
    const v = variants[variantIndex] || variants[0];
    if (mode === 'audio') {
      const aTrack = (item.audios || []).find((a) => a.url) || item.audios?.[0];
      const targetUrl = aTrack?.url || v?.url || item.url;
      return startSegmentJob({
        ...commonMeta,
        kind: 'hls',
        mode: 'audio',
        variantIndex,
        url: targetUrl,
        filename: stem,
        ext: customExt || 'm4a',
        label: 'AUDIO',
        mediaType: 'audio',
      });
    }
    const targetUrl = v?.url || item.url;
    const qLabel = v?.height ? `${v.height}p` : 'HLS';
    let audioUrl = null;
    if (mode === 'both') {
      const aTrack =
        (v?.audioGroup && (item.audios || []).find((a) => a.groupId === v.audioGroup && a.url)) ||
        (item.audios || []).find((a) => a.url);
      if (aTrack) audioUrl = aTrack.url;
    }
    return startSegmentJob({
      ...commonMeta,
      kind: 'hls',
      mode,
      variantIndex,
      url: targetUrl,
      audioUrl,
      filename: stem,
      ext: customExt || 'mp4',
      label: qLabel,
      mediaType: 'video',
    });
  }

  if (item.kind === 'dash') {
    const videos = item.variants || [];
    const audios = item.dashAudios || [];
    const v = videos[variantIndex] || videos[0];
    const a = audios[variantIndex] || audios[0];

    if (mode === 'audio') {
      const rep = a || v;
      if (!rep) throw new Error('Keine Audiospur gefunden');
      const ext = customExt || rep.ext || 'm4a';
      if (rep.single && a) {
        return startDirectDownload({
          ...commonMeta,
          url: rep.single,
          filename: `${stem}.${ext}`,
          label: (rep.format || ext).toUpperCase(),
          mediaType: 'audio',
        });
      }
      return startSegmentJob({
        ...commonMeta,
        kind: 'dash',
        mode: 'audio',
        url: item.url,
        repKind: 'audio',
        repIndex: rep.repIndex ?? rep.index ?? 0,
        repId: rep.repId || '',
        filename: stem,
        ext,
        label: 'AUDIO',
        mediaType: 'audio',
      });
    }

    if (!v) throw new Error('Keine Videospur gefunden');
    const ext = customExt || v.ext || 'mp4';

    if (mode === 'video' && v.single) {
      return startDirectDownload({
        ...commonMeta,
        url: v.single,
        filename: `${stem}.${ext}`,
        label: v.height ? `${v.height}p` : ext.toUpperCase(),
        mediaType: 'video',
      });
    }

    if (mode === 'both' && v.single && !audios.length) {
      return startDirectDownload({
        ...commonMeta,
        url: v.single,
        filename: `${stem}.${ext}`,
        label: v.height ? `${v.height}p` : ext.toUpperCase(),
        mediaType: 'video',
      });
    }

    return startSegmentJob({
      ...commonMeta,
      kind: 'dash',
      mode,
      url: item.url,
      repKind: 'video',
      repIndex: v.repIndex ?? v.index ?? 0,
      repId: v.repId || '',
      filename: stem,
      ext,
      label: v.height ? `${v.height}p` : (v.format || ext).toUpperCase(),
      mediaType: 'video',
    });
  }
}

// ---------------------------------------------------------------------------
// Referer/Origin für Anfragen der Erweiterung setzen
// ---------------------------------------------------------------------------
async function addRefererRule(referer, condition) {
  if (!referer || !/^https?:/i.test(referer)) return null;
  const id = 1 + Math.floor(Math.random() * 2_000_000_000);
  const requestHeaders = [{ header: 'referer', operation: 'set', value: referer }];
  try {
    requestHeaders.push({ header: 'origin', operation: 'set', value: new URL(referer).origin });
  } catch {
    // ignorieren
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders },
          condition: { tabIds: [chrome.tabs.TAB_ID_NONE], ...condition },
        },
      ],
    });
    return id;
  } catch {
    return null;
  }
}

async function removeRule(id) {
  if (!id) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {
    // ignorieren
  }
}

const extensionInitiator = () => ({ initiatorDomains: [chrome.runtime.id] });

async function fetchText(url, referer) {
  const ruleId = await addRefererRule(referer, { ...extensionInitiator(), requestDomains: [urlHost(url)] });
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    removeRule(ruleId);
  }
}

// ---------------------------------------------------------------------------
// Download-Chronik (persistent in chrome.storage.local)
// ---------------------------------------------------------------------------
let historyLock = Promise.resolve();

function updateHistory(fn) {
  const p = historyLock.then(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const updated = (await fn(history)) || history;
    await chrome.storage.local.set({ history: updated });
    return updated;
  });
  historyLock = p.catch(() => {});
  return p;
}

async function recordHistoryEntry(job) {
  await settingsReady;
  if (!settings.historyEnabled) return;
  const max = Math.max(1, Number(settings.maxHistoryEntries) || 100);
  await updateHistory((history) => {
    const entry = {
      id: job.id,
      downloadId: job.downloadId ?? null,
      filename: basename(job.savedPath) || job.filename || `${job.title || 'Video'}.mp4`,
      savedPath: job.savedPath || '',
      title: job.title || 'Video',
      url: job.url || '',
      pageUrl: job.pageUrl || job.referer || '',
      domain: job.domain || urlHost(job.pageUrl || job.referer || job.url || ''),
      favIconUrl: job.favIconUrl || getFavicon(job.pageUrl || job.referer || job.url || ''),
      thumbnail: job.thumbnail || '',
      size: job.size || job.bytes || 0,
      completedAt: Date.now(),
    };
    const filtered = history.filter((h) => h.id !== entry.id);
    filtered.unshift(entry);
    return filtered.slice(0, max);
  });
}

async function enforceHistoryLimit() {
  await settingsReady;
  const max = Math.max(1, Number(settings.maxHistoryEntries) || 100);
  await updateHistory((history) => history.slice(0, max));
}

// ---------------------------------------------------------------------------
// Jobs (Downloads)
// ---------------------------------------------------------------------------
let jobsLock = Promise.resolve();
function updateJobs(fn) {
  const p = jobsLock.then(async () => {
    const { jobs = {} } = await chrome.storage.session.get('jobs');
    const r = await fn(jobs);
    await chrome.storage.session.set({ jobs });
    return r;
  });
  jobsLock = p.catch(() => {});
  return p;
}

const ACTIVE = new Set(['preparing', 'downloading', 'saving']);

async function startSegmentJob(j) {
  await settingsReady;
  const id = crypto.randomUUID();
  const ruleId = await addRefererRule(j.referer, extensionInitiator());
  const saveAs = j.saveAs != null ? !!j.saveAs : !!settings.saveAs;
  await updateJobs((jobs) => {
    jobs[id] = {
      id,
      kind: j.kind,
      url: j.url,
      title: j.title,
      filename: `${j.filename}.${j.ext || 'mp4'}`,
      label: j.label || '',
      mediaType: j.mediaType || 'video',
      referer: j.referer || '',
      pageUrl: j.pageUrl || j.referer || '',
      domain: j.domain || urlHost(j.pageUrl || j.referer || j.url || ''),
      favIconUrl: j.favIconUrl || getFavicon(j.pageUrl || j.referer || j.url || ''),
      thumbnail: j.thumbnail || '',
      saveAs,
      jobSpec: j,
      status: 'preparing',
      done: 0,
      total: 0,
      bytes: 0,
      ruleId,
      createdAt: Date.now(),
    };
  });
  try {
    await ensureOffscreen();
    await sendOffscreen({ type: 'start-job', job: { ...j, id, saveAs, concurrency: settings.concurrency } });
  } catch (e) {
    await finishJob(id, { status: 'error', error: String(e?.message || e) });
  }
  return { ok: true, jobId: id };
}

async function startDirectDownload(j) {
  await settingsReady;
  const saveAs = j.saveAs != null ? !!j.saveAs : !!settings.saveAs;
  const ruleId = await addRefererRule(j.referer, { requestDomains: [urlHost(j.url)] });
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: j.url,
      filename: j.filename,
      saveAs,
      conflictAction: 'uniquify',
    });
  } catch {
    downloadId = await chrome.downloads.download({
      url: j.url,
      saveAs,
      conflictAction: 'uniquify',
    });
  }
  const id = crypto.randomUUID();
  await updateJobs((jobs) => {
    jobs[id] = {
      id,
      kind: 'direct',
      url: j.url,
      title: j.title,
      label: j.label || '',
      mediaType: j.mediaType || 'video',
      referer: j.referer || '',
      pageUrl: j.pageUrl || j.referer || '',
      domain: j.domain || urlHost(j.pageUrl || j.referer || j.url || ''),
      favIconUrl: j.favIconUrl || getFavicon(j.pageUrl || j.referer || j.url || ''),
      thumbnail: j.thumbnail || '',
      jobSpec: j,
      status: 'saving',
      downloadId,
      ruleId,
      filename: j.filename,
      createdAt: Date.now(),
    };
  });
  return { ok: true, jobId: id };
}

async function finishJob(jobId, patch) {
  let job;
  let justCompleted = false;
  await updateJobs((jobs) => {
    job = jobs[jobId];
    if (!job) return;
    const prevStatus = job.status;
    Object.assign(job, patch);
    if (!ACTIVE.has(job.status)) {
      job.finishedAt = Date.now();
      if (job.status === 'done' && prevStatus !== 'done') {
        justCompleted = true;
      }
    }
  });
  if (job && !ACTIVE.has(job.status)) {
    removeRule(job.ruleId);
    if (job.blob) sendOffscreen({ type: 'revoke', jobId }).catch(() => {});
    if (justCompleted) await recordHistoryEntry(job);
    maybeCloseOffscreen();
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state && !delta.filename && !delta.totalBytes) return;
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const job = Object.values(jobs).find((j) => j.downloadId === delta.id);
  if (!job) return;
  const patch = {};
  if (delta.filename?.current) {
    patch.savedPath = delta.filename.current;
    patch.filename = basename(delta.filename.current) || job.filename;
  }
  if (delta.state?.current === 'complete') {
    const [dItem] = await chrome.downloads.search({ id: delta.id });
    if (dItem?.totalBytes > 0) patch.size = dItem.totalBytes;
    if (dItem?.filename) {
      patch.savedPath = dItem.filename;
      patch.filename = basename(dItem.filename) || job.filename;
    }
    patch.status = 'done';
  }
  if (delta.state?.current === 'interrupted') {
    const err = delta.error?.current || 'Unterbrochen';
    patch.status = err === 'USER_CANCELED' ? 'cancelled' : 'error';
    patch.error = err;
  }
  await finishJob(job.id, patch);
});

// ---------------------------------------------------------------------------
// Offscreen-Dokument
// ---------------------------------------------------------------------------
let creatingOffscreen = null;

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Video-Segmente (HLS/DASH) zusammenfügen und Vorschaubilder erzeugen',
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function sendOffscreen(msg, tries = 10) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

async function maybeCloseOffscreen() {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const busy = Object.values(jobs).some((j) => j.kind !== 'direct' && ACTIVE.has(j.status));
  if (!busy && (await hasOffscreen())) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // ignorieren
    }
  }
}

// ---------------------------------------------------------------------------
// Nachrichtenverarbeitung (Popup, Content-Script, Chronik & Offscreen)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return;
  handleMessage(msg, sender)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'page-media-meta': {
      const tabId = msg.tabId ?? sender?.tab?.id;
      if (tabId == null || tabId < 0) return;
      const info = msg.info || {};
      const pageUrl = info.pageUrl || sender?.tab?.url || '';
      const onYouTube = isYouTubePage(pageUrl);
      const normUrl = normalizeYouTubeUrl(pageUrl);

      await withTab(tabId, (data) => {
        data.pageMeta = {
          title: cleanTabTitle(info.title || ''),
          thumbnail: info.thumbnail || data.pageMeta?.thumbnail || '',
          duration: info.duration || data.pageMeta?.duration || 0,
          width: info.width || data.pageMeta?.width || 0,
          height: info.height || data.pageMeta?.height || 0,
        };
        if (onYouTube) {
          data.youtube = true;
          if (normUrl && data.youtubeUrl !== normUrl) {
            data.youtubeUrl = normUrl;
            if (data.youtubeDismissed && data.youtubeDismissedUrl !== normUrl) {
              data.youtubeDismissed = false;
              data.youtubeDismissedUrl = '';
            }
          }
        } else if (pageUrl) {
          data.youtube = false;
          data.youtubeDismissed = false;
          data.youtubeDismissedUrl = '';
          data.youtubeUrl = '';
        }
        for (const item of data.items) {
          if (!item.thumbnail && data.pageMeta.thumbnail) item.thumbnail = data.pageMeta.thumbnail;
          if (!item.duration && data.pageMeta.duration) item.duration = data.pageMeta.duration;
          if (!item.width && data.pageMeta.width) item.width = data.pageMeta.width;
          if (!item.height && data.pageMeta.height) item.height = data.pageMeta.height;
          if (!item.customName && data.pageMeta.title) item.pageTitle = data.pageMeta.title;
        }
      });
      return;
    }

    case 'dismiss-youtube':
      await withTab(msg.tabId, (data) => {
        const normUrl = normalizeYouTubeUrl(msg.url || '') || data.youtubeUrl || '';
        data.youtubeDismissed = true;
        data.youtubeDismissedUrl = normUrl;
        if (normUrl) data.youtubeUrl = normUrl;
      });
      return;

    case 'rename-item':
      await withTab(msg.tabId, (data) => {
        const item = data.items.find((i) => i.id === msg.id);
        if (item) item.customName = cleanTabTitle(msg.name);
      });
      return;

    case 'fetch-text':
      return { ok: true, text: await fetchText(msg.url, msg.referer) };

    case 'clear-media':
      await clearTab(msg.tabId);
      return;

    case 'remove-item':
      await withTab(msg.tabId, (data) => {
        data.items = data.items.filter((i) => i.id !== msg.id);
      });
      return;

    case 'download-item': {
      const data = await readTab(msg.tabId);
      const item = data.items.find((i) => i.id === msg.itemId);
      if (!item) throw new Error('Medium nicht mehr in der Liste');
      return triggerItemDownload(item, {
        variantIndex: msg.variantIndex || 0,
        mode: msg.mode || 'both',
        customExt: msg.customExt || null,
        saveAs: msg.saveAs,
      });
    }

    case 'download-direct':
      return startDirectDownload(msg.job);

    case 'start-job':
      return startSegmentJob(msg.job);

    case 'retry-job': {
      const { jobs = {} } = await chrome.storage.session.get('jobs');
      const old = jobs[msg.jobId];
      if (!old || !old.jobSpec) return;
      await updateJobs((all) => {
        delete all[msg.jobId];
      });
      if (old.kind === 'direct') return startDirectDownload(old.jobSpec);
      return startSegmentJob(old.jobSpec);
    }

    case 'cancel-job': {
      const { jobs = {} } = await chrome.storage.session.get('jobs');
      const job = jobs[msg.jobId];
      if (!job) return;
      if (job.kind === 'direct' && job.downloadId != null) {
        try {
          await chrome.downloads.cancel(job.downloadId);
        } catch {
          // ignorieren
        }
        await finishJob(job.id, { status: 'cancelled' });
      } else {
        await sendOffscreen({ type: 'cancel-job', jobId: msg.jobId }).catch(() => {});
        await finishJob(job.id, { status: 'cancelled' });
      }
      return;
    }

    case 'clear-jobs':
      await updateJobs((jobs) => {
        for (const [id, j] of Object.entries(jobs)) {
          if (!ACTIVE.has(j.status)) delete jobs[id];
        }
      });
      return;

    case 'remove-job':
      await updateJobs((jobs) => {
        if (jobs[msg.jobId] && !ACTIVE.has(jobs[msg.jobId].status)) delete jobs[msg.jobId];
      });
      return;

    case 'remove-history-item':
      await updateHistory((history) => history.filter((h) => h.id !== msg.id));
      await updateJobs((jobs) => {
        if (jobs[msg.id] && !ACTIVE.has(jobs[msg.id].status)) delete jobs[msg.id];
      });
      return;

    case 'clear-history':
      await updateHistory(() => []);
      return;

    case 'play-download':
      if (msg.downloadId != null) {
        try {
          await chrome.downloads.open(msg.downloadId);
        } catch {
          chrome.downloads.show(msg.downloadId);
        }
      }
      return;

    case 'show-download':
      if (msg.downloadId != null) {
        chrome.downloads.show(msg.downloadId);
      }
      return;

    case 'open-downloads-folder':
      chrome.downloads.showDefaultFolder();
      return;

    // ---- vom Offscreen-Dokument ----
    case 'job-update':
      await updateJobs((jobs) => {
        const job = jobs[msg.jobId];
        if (job && ACTIVE.has(job.status)) Object.assign(job, msg.patch);
      });
      if (msg.patch.status && !ACTIVE.has(msg.patch.status)) await finishJob(msg.jobId, {});
      return;

    case 'job-blob-ready': {
      await settingsReady;
      const { jobs = {} } = await chrome.storage.session.get('jobs');
      const curJob = jobs[msg.jobId];
      if (!curJob || curJob.status === 'cancelled') {
        sendOffscreen({ type: 'revoke', jobId: msg.jobId }).catch(() => {});
        return;
      }
      const saveAs = msg.saveAs != null ? !!msg.saveAs : !!settings.saveAs;
      let downloadId;
      try {
        downloadId = await chrome.downloads.download({
          url: msg.blobUrl,
          filename: msg.filename,
          saveAs,
          conflictAction: 'uniquify',
        });
      } catch {
        downloadId = await chrome.downloads.download({
          url: msg.blobUrl,
          saveAs,
          conflictAction: 'uniquify',
        });
      }
      await updateJobs((all) => {
        const job = all[msg.jobId];
        if (job) {
          Object.assign(job, {
            status: 'saving',
            downloadId,
            blob: true,
            filename: msg.filename,
            size: msg.size,
          });
        }
      });
      removeRule(curJob.ruleId);
      return;
    }

    default:
      return { ok: false, error: 'Unbekannte Nachricht: ' + msg.type };
  }
}

scheduleContextMenuRebuild();
