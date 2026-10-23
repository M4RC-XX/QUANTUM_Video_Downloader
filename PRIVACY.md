# Datenschutzerklärung / Privacy Policy – QUANTUM Video Downloader

**Zuletzt aktualisiert / Last updated:** 20. Oktober 2026  
**Entwickler / Developer:** Marc Hamm (`M4RC-XX`) – [https://github.com/M4RC-XX](https://github.com/M4RC-XX)

---

## 🇩🇪 Deutsch – Datenschutzerklärung

### 1. Grundsatz
Der Schutz Ihrer Privatsphäre hat höchste Priorität. **QUANTUM Video Downloader** wurde so entwickelt, dass **keinerlei personenbezogene Daten, Nutzungsdaten oder Browserverläufe an den Entwickler oder an Dritte erhoben, übertragen, gespeichert oder verkauft werden.** Sämtliche Funktionen der Erweiterung werden ausschließlich lokal auf Ihrem eigenen Gerät innerhalb Ihres Browsers ausgeführt.

### 2. Erhebung und Verarbeitung von Daten
- **Keine Server-Übertragung:** Die Erweiterung betreibt keine externen Server, nutzt keine Analyse- oder Tracking-Dienste (wie Google Analytics) und versendet keine Telemetriedaten.
- **Lokale Medienerkennung:** Zur Erkennung herunterladbarer Video- und Audiostreams wertet die Erweiterung technische Netzwerkanfragen (z. B. `Content-Type` von Mediendateien sowie HLS-/DASH-Manifeste) und Video-Metadaten auf der aktuell geöffneten Webseite ausschließlich lokal im Arbeitsspeicher Ihres Browsers (`chrome.storage.session`) aus. Beim Schließen des Tabs oder des Browsers werden diese temporären Sitzungsdaten automatisch verworfen.
- **Lokale Einstellungen & Chronik:**
  - Ihre persönlichen Einstellungen (z. B. gewählte Sprache, Standard-Downloadmodus) werden über `chrome.storage.sync` lokal in Ihrem Browser gespeichert.
  - Sofern aktiviert, wird die optionale Downloadchronik ausschließlich lokal auf Ihrem Gerät in `chrome.storage.local` abgelegt. Sie können einzelne Einträge oder die gesamte Chronik jederzeit mit einem Klick löschen oder die Aufzeichnung in den Einstellungen deaktivieren.

### 3. Berechtigungen der Erweiterung
Alle angeforderten Browser-Berechtigungen (`webRequest`, `webNavigation`, `declarativeNetRequest`, `offscreen`, `downloads`, `downloads.open`, `storage`, `tabs`, `contextMenus` sowie Hostberechtigungen) dienen ausschließlich dem technischen Zweck, Medienströme auf den vom Nutzer besuchten Webseiten zu erkennen, bei Bedarf Video- und Audiospuren lokal im Browser zusammenzuführen und die Dateien auf Wunsch des Nutzers im lokalen Download-Ordner zu speichern.

### 4. Weitergabe an Dritte
Es findet **keinerlei Weitergabe, Übermittlung oder Veräußerung** von Nutzerdaten an Dritte statt.

### 5. Kontakt
Bei Fragen zu dieser Datenschutzerklärung erreichen Sie den Entwickler über GitHub:  
[https://github.com/M4RC-XX](https://github.com/M4RC-XX)

---

## 🇬🇧 English – Privacy Policy

### 1. General Principle
Protecting your privacy is our highest priority. **QUANTUM Video Downloader** is designed so that **no personal data, usage data, or browsing history is ever collected, transmitted, stored on external servers, or sold to the developer or any third party.** All features of the extension run 100% locally on your own device within your browser.

### 2. Data Collection and Processing
- **No External Servers or Tracking:** The extension does not use any external backend servers, analytics tools, or tracking scripts, and does not transmit any telemetry data.
- **Local Media Detection:** To detect downloadable video and audio streams, the extension inspects technical network headers (such as media `Content-Type` headers and HLS/DASH manifests) and video metadata on the active tab strictly locally in your browser's temporary session memory (`chrome.storage.session`). This temporary data is automatically cleared when the tab or browser is closed.
- **Local Settings & Download History:**
  - Your preferences (such as interface language and default download mode) are stored locally via `chrome.storage.sync`.
  - If enabled, the optional download history is stored strictly locally on your device using `chrome.storage.local`. You can delete individual entries, clear the entire history, or disable history recording at any time in the extension settings.

### 3. Extension Permissions
All requested browser permissions (`webRequest`, `webNavigation`, `declarativeNetRequest`, `offscreen`, `downloads`, `downloads.open`, `storage`, `tabs`, `contextMenus`, and host permissions) are used exclusively to detect media streams on websites visited by the user, mux video and audio tracks locally inside the browser when needed, and save the resulting media files to the user's local downloads folder upon request.

### 4. Third-Party Sharing
We **do not share, transfer, or sell** any user data to third parties under any circumstances.

### 5. Contact
If you have any questions regarding this Privacy Policy, you can contact the developer via GitHub:  
[https://github.com/M4RC-XX](https://github.com/M4RC-XX)
