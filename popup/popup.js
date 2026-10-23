import { createTranslator, resolveLanguageCode } from '../lib/i18n.js';
import {
  DEFAULT_SETTINGS,
  cleanTabTitle,
  formatBytes,
  formatBytesDetailed,
  formatBandwidthRate,
  formatDuration,
  urlHost,
  isYouTubePage,
  normalizeYouTubeUrl,
  getFavicon,
  basename,
} from '../lib/util.js';

const $ = (s) => document.querySelector(s);
const ACTIVE = new Set(['preparing', 'downloading', 'saving']);

const ICONS = {
  pencil:
    '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  download:
    '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  link:
    '<svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>',
  retry:
    '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  videoPlaceholder:
    '<svg class="thumb-placeholder" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9zm0 16a7 7 0 1 1 7-7 7 7 0 0 1-7 7zm-2-10.5v7l6-3.5-6-3.5z"/></svg>',
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

let settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
let t = createTranslator(settings.language);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabKey = tab ? `tab_${tab.id}` : null;

const itemSelection = new Map();
let completedHidden = false;

function getSelection(item) {
  if (!itemSelection.has(item.id)) {
    itemSelection.set(item.id, {
      variantIndex: 0,
      mode: item.isAudio ? 'audio' : settings.defaultDownloadMode || 'both',
      customExt: null,
    });
  }
  return itemSelection.get(item.id);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('urlCopied'));
  } catch {
    toast(t('copyFailed'));
  }
}

async function call(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (r && r.ok === false) throw new Error(r.error || 'Error');
  return r;
}

// ---------------------------------------------------------------------------
// Schwebendes Dropdown-Portal (Positionierung relativ zum Anker-Element)
// ---------------------------------------------------------------------------
const portal = $('#dropdown-portal');
let openAnchor = null;

function closeDropdown() {
  portal.hidden = true;
  portal.replaceChildren();
  openAnchor = null;
}

function openDropdown(anchorEl, buildItems) {
  if (openAnchor === anchorEl && !portal.hidden) {
    closeDropdown();
    return;
  }
  openAnchor = anchorEl;
  portal.replaceChildren(...buildItems());
  portal.hidden = false;

  const rect = anchorEl.getBoundingClientRect();
  const pw = portal.offsetWidth || 220;
  const ph = portal.offsetHeight || 180;

  let left = rect.left;
  if (left + pw > window.innerWidth - 8) {
    left = Math.max(8, rect.right - pw);
  }
  let top = rect.bottom + 5;
  if (top + ph > window.innerHeight - 8 && rect.top - ph - 5 > 8) {
    top = rect.top - ph - 5;
  }
  portal.style.left = `${left}px`;
  portal.style.top = `${top}px`;
}

document.addEventListener('click', (e) => {
  if (!portal.hidden && !portal.contains(e.target) && (!openAnchor || !openAnchor.contains(e.target))) {
    closeDropdown();
  }
});

// ---------------------------------------------------------------------------
// Ermittlung verfügbarer Qualitätsstufen, Auflösungen und Containerformate
// ---------------------------------------------------------------------------
function getAvailableOptions(item, sel) {
  if (sel.mode === 'audio') {
    if (item.kind === 'dash' && item.dashAudios?.length) {
      return item.dashAudios.map((a, idx) => ({
        index: idx,
        format: a.format || 'M4A',
        ext: a.ext || 'm4a',
        resLabel: a.lang ? a.lang.toUpperCase() : 'AUDIO',
        fullLabel: [a.format || 'M4A', a.label || a.lang || 'Audio', formatBandwidthRate(a.bandwidth)]
          .filter(Boolean)
          .join(' · '),
        url: a.single || item.url,
      }));
    }
    return [
      { index: 0, format: 'M4A', ext: 'm4a', resLabel: 'AUDIO', fullLabel: 'M4A · Audio', url: item.audios?.[0]?.url || item.url },
      { index: 1, format: 'MP3', ext: 'mp3', resLabel: 'AUDIO', fullLabel: 'MP3 · Audio', url: item.audios?.[0]?.url || item.url },
    ];
  }

  if (item.variants?.length) {
    return item.variants.map((v, idx) => {
      const fmt = v.format || (v.ext || 'mp4').toUpperCase();
      const res = v.width && v.height ? `${v.width}×${v.height}` : v.height ? `${v.height}p` : '';
      const shortRes = v.height ? `${v.height}p` : '';
      const rate = formatBandwidthRate(v.bandwidth);
      return {
        index: idx,
        format: fmt,
        ext: v.ext || 'mp4',
        resLabel: shortRes,
        fullLabel: [res || fmt, fmt, rate].filter(Boolean).join(' · '),
        url: v.single || v.url || item.url,
      };
    });
  }

  const baseExt = (item.ext || 'mp4').toLowerCase();
  const baseFmt = baseExt.toUpperCase();
  const res = item.width && item.height ? `${item.width}×${item.height}` : item.height ? `${item.height}p` : '';
  const shortRes = item.height ? `${item.height}p` : '';
  const sizeStr = formatBytes(item.size);

  const list = [
    {
      index: 0,
      format: baseFmt,
      ext: baseExt,
      resLabel: shortRes,
      fullLabel: [baseFmt, res, sizeStr].filter(Boolean).join(' · '),
      url: item.url,
    },
  ];
  if (!item.isAudio && baseExt !== 'webm') {
    list.push({
      index: 1,
      format: 'WEBM',
      ext: 'webm',
      resLabel: shortRes,
      fullLabel: ['WEBM', res, sizeStr].filter(Boolean).join(' · '),
      url: item.url,
    });
  }
  if (!item.isAudio && baseExt !== 'mkv') {
    list.push({
      index: 2,
      format: 'MKV',
      ext: 'mkv',
      resLabel: shortRes,
      fullLabel: ['MKV', res, sizeStr].filter(Boolean).join(' · '),
      url: item.url,
    });
  }
  return list;
}

function getEffectiveStem(item) {
  if (item.customName) return item.customName;
  const tabTitle = cleanTabTitle(tab?.title || '');
  if (tabTitle && tabTitle !== 'Video') return tabTitle;
  return cleanTabTitle(item.pageTitle || 'Video');
}

// ---------------------------------------------------------------------------
// Darstellung der Medienkarten im Pop-Up
// ---------------------------------------------------------------------------
function buildMediaCard(item) {
  const sel = getSelection(item);
  const options = getAvailableOptions(item, sel);
  const currentOpt = options[sel.variantIndex] || options[0];
  const ext = sel.customExt || currentOpt?.ext || item.ext || 'mp4';
  const protoLabel = item.kind === 'file' ? (item.ext || 'MP4').toUpperCase() : item.kind.toUpperCase();

  // Videovorschau mit Protokoll-Badge (oben rechts) sowie Favicon und Videodauer (unten)
  const thumbWrap = h('div', { class: 'q-thumb' });
  if (item.thumbnail) {
    const img = h('img', { class: 'q-thumb-img', src: item.thumbnail, alt: '' });
    img.addEventListener('error', () => {
      img.replaceWith(h('div', { html: ICONS.videoPlaceholder }).firstElementChild);
    });
    thumbWrap.append(img);
  } else {
    thumbWrap.innerHTML = ICONS.videoPlaceholder;
  }

  thumbWrap.append(h('span', { class: 'q-proto-tag' }, protoLabel));

  const favUrl = item.favIconUrl || getFavicon(item.pageUrl || item.url, tab?.favIconUrl);
  const durText = item.live ? t('liveStream') : formatDuration(item.duration);
  const sizeText = formatBytes(item.size);
  const metaText = durText || sizeText || (currentOpt?.resLabel || '');

  if (favUrl || metaText) {
    const siteWrap = h('div', { class: 'q-thumb-site' });
    if (favUrl) {
      const favImg = h('img', { class: 'q-thumb-fav', src: favUrl, alt: '' });
      favImg.addEventListener('error', () => favImg.remove());
      siteWrap.append(favImg);
    }
    const thumbBar = h(
      'div',
      { class: 'q-thumb-bar' },
      siteWrap,
      metaText ? h('span', { class: 'q-thumb-dur' }, metaText) : null
    );
    thumbWrap.append(thumbBar);
  }

  // Title + Inline Rename
  const stem = getEffectiveStem(item);
  const titleWrap = h('div', { class: 'q-title-wrap', title: `${stem}.${ext}` });

  const renderNormalTitle = (currentStem, currentExt) => {
    titleWrap.classList.remove('editing');
    titleWrap.replaceChildren(
      h('span', { class: 'stem-text' }, currentStem),
      h('span', { class: 'ext-suffix' }, `.${currentExt}`)
    );
  };
  renderNormalTitle(stem, ext);

  const startRename = (e) => {
    if (e) e.stopPropagation();
    closeDropdown();
    const curStem = getEffectiveStem(item);
    titleWrap.classList.add('editing');
    const input = h('input', { type: 'text', class: 'rename-input', value: curStem });
    const extSpan = h('span', { class: 'ext-suffix' }, `.${ext}`);

    const commit = async () => {
      const val = cleanTabTitle(input.value.trim() || curStem);
      item.customName = val;
      renderNormalTitle(val, ext);
      if (tab) {
        await call('rename-item', { tabId: tab.id, id: item.id, name: val }).catch(() => {});
      }
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        input.blur();
      } else if (ev.key === 'Escape') {
        renderNormalTitle(curStem, ext);
      }
    });
    input.addEventListener('blur', commit, { once: true });

    titleWrap.replaceChildren(input, extSpan);
    input.focus();
    input.select();
  };

  titleWrap.addEventListener('click', startRename);

  const removeBtn = h(
    'button',
    {
      class: 'q-icon-close',
      title: t('removeFromList'),
      onclick: () => tab && call('remove-item', { tabId: tab.id, id: item.id }),
    },
    '✕'
  );

  // 3-Way Direct Mode Selector (Video + Audio | Video | Audio)
  const makeModePill = (modeValue, labelKey) =>
    h(
      'button',
      {
        class: 'q-mode-pill' + (sel.mode === modeValue ? ' active' : ''),
        onclick: () => {
          sel.mode = modeValue;
          sel.variantIndex = 0;
          sel.customExt = modeValue === 'audio' ? 'm4a' : null;
          renderAll();
        },
      },
      t(labelKey)
    );

  const modeBar = h(
    'div',
    { class: 'q-mode-segmented' },
    !item.isAudio ? makeModePill('both', 'modeBothShort') : null,
    !item.isAudio ? makeModePill('video', 'modeVideoShort') : null,
    makeModePill('audio', 'modeAudioShort')
  );

  // Quality / Format selector button
  const qBtn = h('button', { class: 'btn-quality', title: t('qualityLabel') });
  const updateQBtnLabel = () => {
    const opts = getAvailableOptions(item, sel);
    const cur = opts[sel.variantIndex] || opts[0];
    const fmtText = cur?.format || ext.toUpperCase();
    const pillText =
      sel.mode === 'audio'
        ? t('audioOnlyBadge')
        : sel.mode === 'video'
        ? cur?.resLabel || t('videoOnlyBadge')
        : cur?.resLabel || '';
    qBtn.replaceChildren(
      pillText ? h('span', { class: 'q-pill' }, pillText) : null,
      h('span', {}, fmtText),
      h('span', { class: 'caret-ud' }, '▾')
    );
  };
  updateQBtnLabel();

  qBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opts = getAvailableOptions(item, sel);
    openDropdown(qBtn, () =>
      opts.map((opt, idx) =>
        h(
          'button',
          {
            class: 'dd-item' + (idx === sel.variantIndex ? ' active' : ''),
            onclick: () => {
              sel.variantIndex = idx;
              sel.customExt = opt.ext;
              closeDropdown();
              renderAll();
            },
          },
          h('span', {}, opt.fullLabel),
          idx === sel.variantIndex ? h('span', {}, '✓') : null
        )
      )
    );
  });

  const renameBtn = h('button', {
    class: 'btn-tool',
    title: t('rename'),
    html: ICONS.pencil,
    onclick: startRename,
  });

  const directUrl = currentOpt?.url || item.url;
  const copyLinkBtn = h('button', {
    class: 'btn-tool',
    title: t('copyUrl'),
    html: ICONS.link,
    onclick: () => copyText(directUrl),
  });

  // QUANTUM Gradient Download Button + Submenu
  const doDownload = async (forceSaveAs = false) => {
    closeDropdown();
    if (item.drm) {
      toast(t('drmError'));
      return;
    }
    try {
      await call('download-item', {
        tabId: tab.id,
        itemId: item.id,
        variantIndex: sel.variantIndex,
        mode: sel.mode,
        customExt: sel.customExt || null,
        saveAs: !!forceSaveAs,
      });
      toast(t('downloadStarted'));
    } catch (err) {
      toast(String(err?.message || err));
    }
  };

  const mainDlBtn = h(
    'button',
    {
      class: 'split-dl-main',
      disabled: !!item.drm,
      onclick: () => doDownload(false),
    },
    h('span', { html: ICONS.download }).firstElementChild,
    h('span', {}, t('download'))
  );

  const caretDlBtn = h(
    'button',
    {
      class: 'split-dl-caret',
      onclick: (e) => {
        e.stopPropagation();
        const opts = getAvailableOptions(item, sel);
        const curOpt = opts[sel.variantIndex] || opts[0];
        const linkToCopy = curOpt?.url || item.url;

        openDropdown(caretDlBtn, () => [
          h(
            'button',
            {
              class: 'dd-item' + (sel.mode === 'both' ? ' active' : ''),
              onclick: () => {
                sel.mode = 'both';
                sel.variantIndex = 0;
                sel.customExt = null;
                closeDropdown();
                renderAll();
                doDownload(false);
              },
            },
            h('span', {}, t('modeBoth')),
            sel.mode === 'both' ? h('span', {}, '✓') : null
          ),
          h(
            'button',
            {
              class: 'dd-item' + (sel.mode === 'video' ? ' active' : ''),
              onclick: () => {
                sel.mode = 'video';
                sel.variantIndex = 0;
                sel.customExt = null;
                closeDropdown();
                renderAll();
                doDownload(false);
              },
            },
            h('span', {}, t('modeVideo')),
            sel.mode === 'video' ? h('span', {}, '✓') : null
          ),
          h(
            'button',
            {
              class: 'dd-item' + (sel.mode === 'audio' ? ' active' : ''),
              onclick: () => {
                sel.mode = 'audio';
                sel.variantIndex = 0;
                sel.customExt = 'm4a';
                closeDropdown();
                renderAll();
                doDownload(false);
              },
            },
            h('span', {}, t('modeAudio')),
            sel.mode === 'audio' ? h('span', {}, '✓') : null
          ),
          h('div', { class: 'dd-sep' }),
          h(
            'button',
            {
              class: 'dd-item',
              onclick: () => doDownload(false),
            },
            h('span', {}, t('download'))
          ),
          h(
            'button',
            {
              class: 'dd-item',
              onclick: () => doDownload(true),
            },
            h('span', {}, t('downloadAs'))
          ),
          h('div', { class: 'dd-sep' }),
          h(
            'button',
            {
              class: 'dd-item',
              onclick: () => {
                closeDropdown();
                copyText(linkToCopy);
              },
            },
            h('span', {}, t('copyUrl'))
          ),
        ]);
      },
    },
    '▾'
  );

  return h(
    'div',
    { class: 'q-media-card' },
    h(
      'div',
      { class: 'q-card-main' },
      thumbWrap,
      h('div', { class: 'q-info' }, h('div', { class: 'q-title-row' }, titleWrap, removeBtn), modeBar)
    ),
    h(
      'div',
      { class: 'q-card-footer' },
      h('div', { class: 'q-footer-left' }, qBtn, renameBtn, copyLinkBtn),
      h('div', { class: 'split-dl' }, mainDlBtn, caretDlBtn)
    )
  );
}

// ---------------------------------------------------------------------------
// Darstellung aktiver und abgeschlossener Downloads
// ---------------------------------------------------------------------------
let currentTabData = { items: [], youtube: false, youtubeDismissed: false };
let jobsState = {};
let historyState = [];
const directProgress = new Map();

function buildActiveJobCard(j) {
  let pct = null;
  let left = '';
  let right = '';

  switch (j.status) {
    case 'preparing':
      left = t('preparing');
      break;
    case 'downloading':
      pct = j.total ? (j.done / j.total) * 100 : null;
      left = `${t('segments')} ${j.done}/${j.total}`;
      right = formatBytesDetailed(j.bytes);
      break;
    case 'saving':
      if (j.kind === 'direct') {
        const p = directProgress.get(j.downloadId);
        left = t('downloading');
        if (p) {
          pct = p.total > 0 ? (p.received / p.total) * 100 : null;
          right = [formatBytesDetailed(p.received), p.total > 0 ? formatBytesDetailed(p.total) : '']
            .filter(Boolean)
            .join(' / ');
        }
      } else {
        left = t('saving');
        right = formatBytesDetailed(j.size || j.bytes);
      }
      break;
    default:
      left = j.status;
  }

  const fill = h('div');
  if (pct != null) fill.style.width = `${pct.toFixed(1)}%`;

  return h(
    'div',
    { class: 'active-job' },
    h(
      'div',
      { class: 'active-job-head' },
      h('div', { class: 'active-job-title', title: j.filename || j.title }, j.filename || j.title),
      h(
        'button',
        {
          class: 'q-icon-close',
          title: t('cancel'),
          onclick: () => call('cancel-job', { jobId: j.id }),
        },
        '✕'
      )
    ),
    h('div', { class: 'active-job-sub' }, h('span', {}, left), h('span', {}, right)),
    h('div', { class: 'progress' + (pct == null ? ' indeterminate' : '') }, fill)
  );
}

function buildCompletedCard(entry) {
  const filename = basename(entry.savedPath) || entry.filename || `${entry.title || 'Video'}.mp4`;
  const domain = entry.domain || urlHost(entry.pageUrl || entry.url || '') || 'local';
  const favUrl = entry.favIconUrl || getFavicon(entry.pageUrl || entry.url || '');

  const favImg = favUrl ? h('img', { src: favUrl, alt: '' }) : null;
  if (favImg) favImg.addEventListener('error', () => favImg.remove());

  const domainBtn = h(
    'button',
    {
      class: 'domain-pill',
      title: entry.pageUrl || domain,
      onclick: () => {
        if (entry.pageUrl && /^https?:/i.test(entry.pageUrl)) {
          chrome.tabs.create({ url: entry.pageUrl });
        }
      },
    },
    favImg,
    h('span', {}, domain)
  );

  const openBtn = h(
    'button',
    {
      class: 'btn-done-action',
      disabled: entry.downloadId == null,
      onclick: () => {
        if (entry.downloadId == null) return;
        try {
          const p = chrome.downloads.open(entry.downloadId);
          if (p && typeof p.catch === 'function') {
            p.catch(() => chrome.downloads.show(entry.downloadId));
          }
        } catch {
          chrome.downloads.show(entry.downloadId);
        }
      },
    },
    h('span', { html: ICONS.play }).firstElementChild,
    h('span', {}, t('play'))
  );

  const folderBtn = h('button', {
    class: 'btn-done-icon',
    title: t('showInFolder'),
    disabled: entry.downloadId == null,
    html: ICONS.folder,
    onclick: () => {
      if (entry.downloadId != null) {
        chrome.downloads.show(entry.downloadId);
      }
    },
  });

  const retryBtn = entry.fromSession
    ? h('button', {
        class: 'btn-done-icon',
        title: t('retry'),
        html: ICONS.retry,
        onclick: () => call('retry-job', { jobId: entry.id }),
      })
    : null;

  const removeBtn = h('button', {
    class: 'btn-done-icon danger',
    title: t('removeFromList'),
    html: ICONS.trash,
    onclick: () => call('remove-history-item', { id: entry.id }),
  });

  return h(
    'div',
    { class: 'completed-card' },
    h('div', { class: 'completed-title', title: filename }, filename),
    h(
      'div',
      { class: 'completed-row' },
      domainBtn,
      h('div', { class: 'completed-btns' }, openBtn, folderBtn, retryBtn, removeBtn)
    )
  );
}

// ---------------------------------------------------------------------------
// Haupt-Rendering & Synchronisation mit dem Hintergrund-Service-Worker
// ---------------------------------------------------------------------------
function applyStaticTranslations() {
  document.documentElement.lang = resolveLanguageCode(settings.language);
  $('#yt-title').textContent = t('ytTitle');
  $('#yt-message').textContent = t('ytMessage');
  $('#empty-title').textContent = t('noMediaTitle');
  $('#empty-sub').textContent = t('noMediaSub');
  $('#completed-label').textContent = t('completedSection');
  $('#btn-toggle-completed').textContent = completedHidden ? t('show') : t('hide');
  $('#btn-show-all-history').textContent = t('showAll');
  $('#btn-settings').title = t('settings');
  $('#btn-history').title = t('openHistory');
  $('#btn-folder').title = t('openDownloadsFolder');
  $('#btn-clear-completed').title = t('clearCompleted');
}

function renderAll() {
  applyStaticTranslations();

  // YouTube-Hinweis nur anzeigen, wenn der aktuelle Tab selbst YouTube ist und die Meldung
  // für die aktuelle Seiten-URL noch nicht über das Schließen-Symbol ausgeblendet wurde.
  const activeTabIsYouTube = Boolean(tab?.url && isYouTubePage(tab.url));
  const currentNormUrl = normalizeYouTubeUrl(tab?.url || '');
  const dismissedForCurrentUrl =
    Boolean(currentTabData.youtubeDismissed) &&
    (!currentTabData.youtubeDismissedUrl || currentTabData.youtubeDismissedUrl === currentNormUrl);
  const isYt = activeTabIsYouTube && !dismissedForCurrentUrl;
  $('#yt-banner').hidden = !isYt;

  const items = currentTabData.items || [];
  const countPill = $('#media-count');
  countPill.textContent = String(items.length);
  countPill.hidden = items.length === 0;

  const mediaList = $('#media-list');
  mediaList.replaceChildren(...[...items].reverse().map((item) => buildMediaCard(item)));

  const allJobs = Object.values(jobsState).sort((a, b) => b.createdAt - a.createdAt);
  const activeJobs = allJobs.filter((j) => ACTIVE.has(j.status));
  $('#active-jobs').replaceChildren(...activeJobs.map((j) => buildActiveJobCard(j)));

  const completedMap = new Map();
  for (const j of allJobs) {
    if (j.status === 'done') {
      completedMap.set(j.id, { ...j, fromSession: true });
    }
  }
  if (settings.historyEnabled) {
    for (const hItem of historyState) {
      if (!completedMap.has(hItem.id)) {
        completedMap.set(hItem.id, hItem);
      }
    }
  }
  const completedEntries = Array.from(completedMap.values()).slice(0, 8);

  const compSection = $('#completed-section');
  compSection.hidden = completedEntries.length === 0;
  const compList = $('#completed-list');
  compList.hidden = completedHidden;
  compList.replaceChildren(...completedEntries.map((entry) => buildCompletedCard(entry)));

  $('#empty').hidden = items.length > 0 || isYt || activeJobs.length > 0;
}

// ---------------------------------------------------------------------------
// Ereignisbehandlung & Initialisierung
// ---------------------------------------------------------------------------
$('#yt-close').addEventListener('click', () => {
  const currentUrl = tab?.url || '';
  currentTabData.youtubeDismissed = true;
  currentTabData.youtubeDismissedUrl = normalizeYouTubeUrl(currentUrl);
  renderAll();
  if (tab) call('dismiss-youtube', { tabId: tab.id, url: currentUrl }).catch(() => {});
});

$('#btn-toggle-completed').addEventListener('click', () => {
  completedHidden = !completedHidden;
  renderAll();
});

$('#btn-show-all-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
});

$('#btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('#btn-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
});

$('#btn-folder').addEventListener('click', () => {
  if (chrome.downloads?.showDefaultFolder) {
    chrome.downloads.showDefaultFolder();
  } else {
    call('open-downloads-folder').catch(() => {});
  }
});

$('#btn-clear-completed').addEventListener('click', async () => {
  await call('clear-jobs').catch(() => {});
  await call('clear-history').catch(() => {});
});

// Fortschritt laufender direkter Browser-Downloads regelmäßig abfragen
setInterval(async () => {
  const running = Object.values(jobsState).filter(
    (j) => j.kind === 'direct' && j.status === 'saving' && j.downloadId != null
  );
  if (!running.length) return;
  for (const j of running) {
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (d) directProgress.set(j.downloadId, { received: d.bytesReceived, total: d.totalBytes });
  }
  renderAll();
}, 900);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tab && tabId === tab.id && changeInfo.url) {
    tab.url = changeInfo.url;
    renderAll();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (tabKey && changes[tabKey]) {
      currentTabData = changes[tabKey].newValue || { items: [], youtube: false, youtubeDismissed: false };
    }
    if (changes.jobs) {
      jobsState = changes.jobs.newValue || {};
    }
    renderAll();
  } else if (area === 'local' && changes.history) {
    historyState = changes.history.newValue || [];
    renderAll();
  } else if (area === 'sync') {
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (newValue !== undefined) settings[k] = newValue;
    }
    t = createTranslator(settings.language);
    renderAll();
  }
});

if (tab?.id != null && /^https?:/i.test(tab.url || '')) {
  chrome.tabs
    .sendMessage(tab.id, { type: 'get-page-meta' })
    .then((info) => {
      if (info) {
        chrome.runtime.sendMessage({ target: 'background', type: 'page-media-meta', tabId: tab.id, info }).catch(() => {});
      }
    })
    .catch(() => {});
}

const sessionInit = await chrome.storage.session.get(tabKey ? [tabKey, 'jobs'] : ['jobs']);
const localInit = await chrome.storage.local.get('history');
currentTabData = (tabKey && sessionInit[tabKey]) || { items: [], youtube: false, youtubeDismissed: false };
jobsState = sessionInit.jobs || {};
historyState = localInit.history || [];
renderAll();
