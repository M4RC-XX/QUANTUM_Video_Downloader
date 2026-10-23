// Verwaltung und Darstellung der persistenten Downloadchronik (chrome.storage.local)
import { createTranslator, resolveLanguageCode } from '../lib/i18n.js';
import { DEFAULT_SETTINGS, urlHost, getFavicon, basename } from '../lib/util.js';

const $ = (s) => document.querySelector(s);

const ICONS = {
  trash:
    '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
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

const call = (type, data = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...data });

let settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
let t = createTranslator(settings.language);
let historyList = (await chrome.storage.local.get('history')).history || [];
let query = '';

function buildCard(entry) {
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
      class: 'btn-open-file',
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
    class: 'btn-icon',
    title: t('showInFolder'),
    disabled: entry.downloadId == null,
    html: ICONS.folder,
    onclick: () => {
      if (entry.downloadId != null) {
        chrome.downloads.show(entry.downloadId);
      }
    },
  });

  const trashBtn = h('button', {
    class: 'btn-icon danger',
    title: t('removeFromList'),
    html: ICONS.trash,
    onclick: () => call('remove-history-item', { id: entry.id }),
  });

  return h(
    'div',
    { class: 'history-card' },
    h('div', { class: 'history-title' }, filename),
    h('div', { class: 'history-row' }, domainBtn, h('div', { class: 'history-actions' }, openBtn, folderBtn, trashBtn))
  );
}

function render() {
  document.documentElement.lang = resolveLanguageCode(settings.language);
  document.title = `${t('historyTitle')} – QUANTUM`;
  $('#page-title').textContent = t('historyTitle');
  $('#search-input').placeholder = t('searchPlaceholder');
  $('#btn-clear-history').textContent = t('clearHistory');
  $('#history-count-badge').textContent = String(historyList.length);

  const toggleBtn = $('#btn-toggle-recording');
  toggleBtn.textContent = settings.historyEnabled ? t('disableHistory') : t('enableHistory');
  toggleBtn.classList.toggle('inactive-state', !settings.historyEnabled);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? historyList.filter(
        (item) =>
          (item.filename || '').toLowerCase().includes(q) ||
          (item.title || '').toLowerCase().includes(q) ||
          (item.domain || '').toLowerCase().includes(q)
      )
    : historyList;

  const listEl = $('#history-list');
  listEl.replaceChildren(...filtered.map((item) => buildCard(item)));
  $('#empty-state').textContent = t('historyEmpty');
  $('#empty-state').hidden = filtered.length > 0;
}

$('#search-input').addEventListener('input', (e) => {
  query = e.target.value;
  render();
});

$('#btn-clear-history').addEventListener('click', () => {
  call('clear-history');
});

$('#btn-toggle-recording').addEventListener('click', async () => {
  settings.historyEnabled = !settings.historyEnabled;
  await chrome.storage.sync.set({ historyEnabled: settings.historyEnabled });
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) {
    historyList = changes.history.newValue || [];
    render();
  } else if (area === 'sync') {
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (newValue !== undefined) settings[k] = newValue;
    }
    t = createTranslator(settings.language);
    render();
  }
});

render();
