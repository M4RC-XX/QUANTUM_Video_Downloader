// Content-Script zur Ermittlung von Seiten-Metadaten (Vorschaubild, Videodauer, Auflösung)
// direkt aus aktiven HTML5-Video-Elementen oder OpenGraph-Meta-Tags der Webseite.
(() => {
  if (window.__quantumDetectorLoaded) return;
  window.__quantumDetectorLoaded = true;

  /**
   * Liest das Vorschaubild der Seite aus gängigen Meta-Tags (OpenGraph / Twitter Card),
   * falls kein direkter Video-Frame über Canvas abgegriffen werden kann.
   */
  function getMetaImage() {
    const selectors = [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'link[rel="image_src"]',
    ];
    for (const sel of selectors) {
      const content = document.querySelector(sel)?.getAttribute('content') || document.querySelector(sel)?.getAttribute('href');
      if (content) {
        try {
          return new URL(content, location.href).href;
        } catch {
          return content;
        }
      }
    }
    return '';
  }

  /**
   * Erzeugt ein kompaktes JPEG-Vorschaubild (Data-URL) aus dem aktuellen Frame eines <video>-Elements.
   * Schlägt bei Cross-Origin-Videos ohne CORS-Freigabe fehl und gibt dann einen leeren String zurück.
   */
  function captureVideoFrame(video) {
    try {
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
      const w = 240;
      const h = Math.max(90, Math.round((video.videoHeight / video.videoWidth) * w));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return '';
    }
  }

  function collectPageMediaInfo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let bestDuration = 0;
    let bestThumb = '';
    let width = 0;
    let height = 0;

    // Videos absteigend nach sichtbarer Fläche sortieren, um den Hauptplayer zu priorisieren
    videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));

    for (const v of videos) {
      if (v.duration && isFinite(v.duration) && v.duration > bestDuration) {
        bestDuration = v.duration;
      }
      if (!width && v.videoWidth) {
        width = v.videoWidth;
        height = v.videoHeight;
      }
      if (!bestThumb) {
        const frame = captureVideoFrame(v);
        if (frame) bestThumb = frame;
        else if (v.poster) {
          try {
            bestThumb = new URL(v.poster, location.href).href;
          } catch {
            bestThumb = v.poster;
          }
        }
      }
    }

    if (!bestThumb) bestThumb = getMetaImage();

    const isYt = /(^|\.)(youtube\.com|youtu\.be)$/i.test(location.hostname);

    return {
      title: document.title || '',
      pageUrl: location.href,
      thumbnail: bestThumb,
      duration: bestDuration,
      width,
      height,
      youtube: isYt,
    };
  }

  let sendTimer = null;
  function scheduleNotify() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      try {
        const info = collectPageMediaInfo();
        chrome.runtime.sendMessage({ target: 'background', type: 'page-media-meta', info }).catch(() => {});
      } catch {
        // Wird ausgelöst, wenn die Erweiterung neu geladen wurde, während der Tab noch offen ist
      }
    }, 350);
  }

  document.addEventListener('loadedmetadata', scheduleNotify, true);
  document.addEventListener('loadeddata', scheduleNotify, true);
  document.addEventListener('play', scheduleNotify, true);
  document.addEventListener('durationchange', scheduleNotify, true);
  window.addEventListener('yt-navigate-finish', scheduleNotify);
  window.addEventListener('popstate', scheduleNotify);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'get-page-meta') {
      sendResponse(collectPageMediaInfo());
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleNotify, { once: true });
  } else {
    scheduleNotify();
  }
})();
