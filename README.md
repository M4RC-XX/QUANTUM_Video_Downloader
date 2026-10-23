# QUANTUM Video Downloader

<div align="center">

<a href="https://chromewebstore.google.com/detail/amifjioeobkepofkaieinlpleapicoaa" target="_blank" rel="noopener noreferrer">
  <img src="https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQKhXduv1/iNEsLEb3vdWgfZha1BpC.png" alt="Available in the Chrome Web Store" height="60">
</a>

<br>

<a href="https://chromewebstore.google.com/detail/amifjioeobkepofkaieinlpleapicoaa" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/Chrome_Web_Store-Hinzufügen_/_Add_to_Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="In Chrome installieren">
</a>

<br><br>

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0ea5e9?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License](https://img.shields.io/badge/License-Proprietary%20%2F%20Attribution-blue?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0%20Archer-emerald?style=flat-square)](manifest.json)

**Moderne, schlanke Chrome-/Chromium-Erweiterung (Manifest V3) zum Erkennen und Herunterladen von Videos und Audios (MP4, WebM, MKV, HLS/.m3u8, DASH/.mpd) direkt im Browser.**

</div>

---

## 🇩🇪 Deutsch

### Funktionsumfang

- **Medien-Erkennung & Vorschau:** Automatische Erkennung aktiver Video-/Audio-Streams mit Videovorschau, Webseiten-Favicon, Videodauer und Dateigröße.
- **Integrierter MP4-Combiner:** Führt getrennte Video- und Audiospuren (fMP4, HLS MPEG-TS, ADTS AAC) direkt im Browser ohne externe Konverter zu einer standardkonformen, abspielbaren MP4-Datei zusammen.
- **Qualitäts- & Formatauswahl:** Flexible Auswahl aller verfügbaren Auflösungen (`2160p`, `1440p`, `1080p`, `720p`, …), Bitraten und Formate (`MP4`, `WEBM`, `MKV`, `M4A`, `MP3`).
- **3 Download-Modi:** Wählbar zwischen **Video + Audio** (kombiniert), **Nur Video** und **Nur Audio**.
- **Direktlink-Kopie & Dateinamen:** 1-Klick-Kopie des direkten Medienlinks in die Zwischenablage und Inline-Umbenennen des Titels vor dem Download.
- **Kontextmenü:** Rechtsklick-Menü auf jeder Webseite für schnellen Zugriff auf alle erkannten Medien.
- **Downloadchronik:** Optionale, durchsuchbare Chronik mit Domain-Anzeige, Favicon, Abspielen- und Ordner-Buttons.
- **Vollständige Lokalisierung:** Unterstützt Deutsch, Englisch, Französisch und Spanisch (automatische Erkennung nach `chrome.i18n` oder manuell wählbar).

### Installation

#### Option 1: Direkt aus dem Chrome Web Store (Empfohlen)

Klicke einfach auf den folgenden Button, um die Erweiterung direkt mit einem Klick in Chrome zu installieren:

<p align="left">
  <a href="https://chromewebstore.google.com/detail/amifjioeobkepofkaieinlpleapicoaa" target="_blank" rel="noopener noreferrer">
    <img src="https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQKhXduv1/iNEsLEb3vdWgfZha1BpC.png" alt="Im Chrome Web Store ansehen" height="54">
  </a>
</p>

*Zukünftige Updates werden dadurch automatisch im Hintergrund über den Chrome Web Store installiert.*

#### Option 2: Manuell aus dem Quellcode (Entwicklermodus)

1. Repository klonen oder als ZIP herunterladen und entpacken:
   ```bash
   git clone https://github.com/M4RC-XX/QUANTUM-Video-Downloader.git
   ```
2. In Google Chrome die Seite `chrome://extensions/` öffnen.
3. Oben rechts den Schalter **Entwicklermodus** aktivieren.
4. Auf **Entpackte Erweiterung laden** klicken und den Projektordner auswählen.

---

## 🇬🇧 English

### Features

- **Media Detection & Preview:** Real-time detection of video and audio streams with frame thumbnails, site favicons, duration, and file size.
- **Built-in In-Browser MP4 Muxer:** Merges separate video and audio streams (fMP4, HLS MPEG-TS, ADTS AAC) directly inside the browser into standard playable MP4 files — no external tools required.
- **Quality & Format Selection:** Choose from all available resolutions (`2160p`, `1440p`, `1080p`, `720p`, etc.), bitrates, and containers (`MP4`, `WEBM`, `MKV`, `M4A`, `MP3`).
- **3 Download Modes:** Switch easily between **Video + Audio** (combined), **Video only**, and **Audio only**.
- **Direct Link Copy & Inline Rename:** One-click direct media URL copy and inline filename editing before downloading.
- **Context Menu:** Right-click anywhere on the page to quickly download detected media.
- **Download History:** Optional searchable history page with domain badges, favicons, open, and folder actions.
- **Full Localization:** Supports English, German, French, and Spanish using standard `chrome.i18n`.

### Installation

#### Option 1: Directly from the Chrome Web Store (Recommended)

Click the button below to install QUANTUM with a single click from the Chrome Web Store:

<p align="left">
  <a href="https://chromewebstore.google.com/detail/amifjioeobkepofkaieinlpleapicoaa" target="_blank" rel="noopener noreferrer">
    <img src="https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQKhXduv1/iNEsLEb3vdWgfZha1BpC.png" alt="Available in the Chrome Web Store" height="54">
  </a>
</p>

*Updates will be installed automatically in the background.*

#### Option 2: From Source (Developer Mode)

1. Clone or download and extract this repository:
   ```bash
   git clone https://github.com/M4RC-XX/QUANTUM-Video-Downloader.git
   ```
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the repository directory.

---

## Richtlinien / Policy Note

Aufgrund der Richtlinien des Chrome Web Stores werden Downloads von YouTube sowie DRM-geschützte Streams nicht unterstützt.  
*In compliance with Chrome Web Store policies, downloading from YouTube and DRM-protected streams is not supported.*

---

## Lizenz / License

Copyright (c) 2026 **Marc Hamm (`M4RC-XX`)**  
Details zu den Nutzungs- und Lizenzbedingungen siehe [LICENSE](LICENSE).
