// Einstellungsseite der Erweiterung – synchronisiert Änderungen unmittelbar über chrome.storage.sync
import { DEFAULT_SETTINGS } from '../lib/util.js';
import { createTranslator, resolveLanguageCode, SUPPORTED_LANGUAGES } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);

const langSelect = $('#language');
for (const l of SUPPORTED_LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = l.code;
  opt.textContent = l.label;
  if (l.labelKey) opt.dataset.labelKey = l.labelKey;
  langSelect.append(opt);
}

const fields = Object.keys(DEFAULT_SETTINGS);
const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
let timer;

function applyLabels(lang) {
  const t = createTranslator(lang);
  document.documentElement.lang = resolveLanguageCode(lang);
  for (const opt of langSelect.options) {
    if (opt.dataset.labelKey) {
      opt.textContent = t(opt.dataset.labelKey);
    }
  }
  document.title = `QUANTUM – ${t('optTitle')}`;
  $('#lbl-title').textContent = t('optTitle');
  $('#sec-general').textContent = t('optGeneral');
  $('#lbl-language').textContent = t('optLanguage');
  $('#sub-language').textContent = t('optLanguageSub');
  $('#lbl-defaultMode').textContent = t('optDefaultMode');
  $('#sub-defaultMode').textContent = t('optDefaultModeSub');
  $('#opt-mode-both').textContent = t('modeBoth');
  $('#opt-mode-video').textContent = t('modeVideo');
  $('#opt-mode-audio').textContent = t('modeAudio');
  $('#lbl-clearOnNav').textContent = t('optClearOnNav');
  $('#sub-clearOnNav').textContent = t('optClearOnNavSub');
  $('#sec-history').textContent = t('optHistorySection');
  $('#lbl-historyEnabled').textContent = t('optHistoryEnabled');
  $('#sub-historyEnabled').textContent = t('optHistoryEnabledSub');
  $('#lbl-maxHistory').textContent = t('optMaxHistory');
  $('#sub-maxHistory').textContent = t('optMaxHistorySub');
  $('#lbl-openHistory').textContent = t('historyTitle');
  $('#btn-open-history').textContent = t('openHistory');
  $('#sec-advanced').textContent = t('optAdvancedSection');
  $('#lbl-minSize').textContent = t('optMinSize');
  $('#sub-minSize').textContent = t('optMinSizeSub');
  $('#lbl-concurrency').textContent = t('optConcurrency');
  $('#sub-concurrency').textContent = t('optConcurrencySub');
  $('#sec-about').textContent = t('optAboutSection');
  $('#lbl-author').textContent = t('optAuthor');
  $('#lbl-version').textContent = t('optVersion');
  $('#lbl-license').textContent = t('optLicense');
  $('#sub-license').textContent = t('optLicenseText');
}

const manifest = chrome.runtime.getManifest();
if ($('#val-version')) {
  $('#val-version').textContent = manifest.version_name || manifest.version;
}

for (const key of fields) {
  const el = document.getElementById(key);
  if (!el) continue;
  if (el.type === 'checkbox') el.checked = !!settings[key];
  else el.value = settings[key];

  el.addEventListener('change', async () => {
    let value;
    if (el.type === 'checkbox') {
      value = el.checked;
    } else if (el.type === 'number') {
      value = Number(el.value);
      if (!isFinite(value)) value = DEFAULT_SETTINGS[key];
      if (el.min !== '') value = Math.max(Number(el.min), value);
      if (el.max !== '') value = Math.min(Number(el.max), value);
      el.value = value;
    } else {
      value = el.value;
    }

    settings[key] = value;
    await chrome.storage.sync.set({ [key]: value });
    applyLabels(settings.language);

    const t = createTranslator(settings.language);
    const s = $('#saved');
    s.textContent = `${t('optSaved')} ✓`;
    clearTimeout(timer);
    timer = setTimeout(() => (s.textContent = ''), 1600);
  });
}

$('#btn-open-history').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
});

applyLabels(settings.language);
