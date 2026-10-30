# SKNews

Persönliches News-Dashboard für World of Warcraft (inkl. eigener Charaktere), Tesla, SpaceX, Aktien und Crypto. Es sortiert die News danach, was dich interessiert, und lernt aus deinen Bewertungen.

## So funktioniert es

- **Sammler** (`collector/collect.py`): läuft stündlich als GitHub Action. Er liest `config/interests.json` und holt
  - RSS/Atom-Feeds (bei normalen Webseiten wird der Feed automatisch gesucht),
  - Google-News-Ergebnisse für jeden Suchbegriff,
  - Raider.io-Daten für deine WoW-Charaktere (M+-Wertung, Itemlevel, Raid-Fortschritt; jede Änderung wird zu einer Meldung),
  - neue Videos deiner YouTube-Kanäle (siehe unten).

  Ergebnis landet in `docs/data/`. Artikel älter als 14 Tage fallen raus.
- **Dashboard** (`docs/index.html`): statische Seite auf GitHub Pages. Ranking = Frische × Themen-Gewicht + Treffer deiner Suchbegriffe + gelernte Gewichte aus deinen Bewertungen (+ / −, gelesen, ausgeblendet). Bei jedem Artikel steht, warum er oben ist.
- **Lernen und Anpassen**: Neue Begriffe, URLs, Charaktere und Themen gibst du direkt im Dashboard ein. Mit einem GitHub-Token (Einstellungen) werden sie in `config/interests.json` gespeichert und ein neuer Abruf startet sofort. Bewertungen landen in `docs/data/feedback.json`, damit sie auf allen Geräten gelten.

- **YouTube-Kanäle**: Kanäle trägst du im Dashboard ein, als `@name` oder als Link zum Kanal, und wählst je Kanal, wie die Videos ausgewertet werden. Die Auswertung steht danach als Zusammenfassung und Kernpunkte an der Karte, auf Deutsch, auch bei englischen Videos.
  - **Gemini**: Der Sammler gibt Gemini die YouTube-URL, Gemini schaut sich Bild und Ton direkt an. Dafür braucht das Repo das Secret `GEMINI_API_KEY` (Settings → Secrets and variables → Actions; Schlüssel gibt es unter https://aistudio.google.com/apikey). Ein Video von zehn Minuten braucht etwa 45.000 Token, bei Gemini Flash sind das wenige Cent.
  - **Parakeet (lokal)**: Ein kleiner Dienst bei dir zu Hause lädt den Ton, Parakeet schreibt mit, dein Ollama-Modell zieht die Infos heraus. Kostet nichts und bleibt auf deinen Geräten. Anleitung in [`transkript/README.md`](transkript/README.md).
  - **Nur auflisten**: Die Videos erscheinen ohne Auswertung.

  Ausgewertet werden nur Videos der letzten drei Tage, Gemini nimmt höchstens vier pro Abruf, Shorts bleiben draußen. Das lässt sich in `config/interests.json` ändern, zum Beispiel `"videos": {"maxPerRun": 4, "maxAgeDays": 3, "maxMinutes": 60, "shorts": false, "geminiModel": "gemini-flash-latest"}`.

- **Telegram-Bot** (`bot/`): Chat am Handy mit Gedächtnis über alle gesammelten Artikel, deine Bewertungen und Notizen, auf Wunsch auch Haus-Assistent (Home Assistant, Logs, Erreichbarkeit, Schalten mit Bestätigung). Läuft als Docker-Container, z. B. auf ZimaOS. Anleitung in [`bot/README.md`](bot/README.md).

## Einrichtung

1. **Pages aktivieren:** Settings → Pages → Source: *Deploy from a branch*, Branch `main`, Ordner `/docs`.
2. **Actions erlauben:** Settings → Actions → General → Workflow permissions: *Read and write permissions*.
3. Einmal manuell starten: Actions → *News sammeln* → *Run workflow*.
4. Dashboard öffnen: `https://<dein-login>.github.io/sknews/`
5. Optional für Sync: Fine-grained Token nur für dieses Repo mit `Contents: Read and write` und `Actions: Read and write`, im Dashboard unter *Einstellungen* eintragen.

Hinweis: Bei einem privaten Repo braucht GitHub Pages ein bezahltes Konto. Die Seite selbst enthält keine Geheimnisse, der Token bleibt nur in deinem Browser.

## Lokal testen

```bash
python3 collector/collect.py
python3 -m http.server -d docs 8000
```
