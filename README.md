# SKNews

Persönliches News-Dashboard für World of Warcraft (inkl. eigener Charaktere), Tesla, SpaceX, Aktien und Crypto. Es sortiert die News danach, was dich interessiert, und lernt aus deinen Bewertungen.

## So funktioniert es

- **Sammler** (`collector/collect.py`): läuft stündlich als GitHub Action. Er liest `config/interests.json` und holt
  - RSS/Atom-Feeds (bei normalen Webseiten wird der Feed automatisch gesucht),
  - Google-News-Ergebnisse für jeden Suchbegriff,
  - Raider.io-Daten für deine WoW-Charaktere (M+-Wertung, Itemlevel, Raid-Fortschritt; jede Änderung wird zu einer Meldung),
  - neue Videos deiner YouTube-Kanäle (siehe unten).

  Ergebnis landet in `docs/data/`. Artikel älter als 14 Tage fallen raus.

  GitHubs stündlicher Zeitplan läuft in der Praxis nur etwa alle 5 Stunden. Deshalb stößt SK (Repo `sk-ki-os`) den Workflow jede Stunde selbst an (`workflow_dispatch`), sobald dort `SKNEWS_TOKEN` gesetzt ist; der Zeitplan bleibt als Rückfall.
  Pro Thema filtern `exclude` (reguläre Ausdrücke auf den Titel) unerwünschte Artikel heraus, `keep` übergeht den Filter, z. B. WoW ohne „Forever“/Classic, aber mit Midnight.
- **Dashboard** (`docs/index.html`): statische Seite unter https://news.skzone.de (Cloudflare Pages, die Action lädt `docs/` nach jedem Lauf hoch). Oben steht, wie alt die Daten sind (gelb ab 2 Stunden, rot ab 12 Stunden). Ranking = Frische × Themen-Gewicht + Treffer deiner Suchbegriffe + gelernte Gewichte aus deinen Bewertungen (+ / −, gelesen, ausgeblendet). Bei jedem Artikel steht, warum er oben ist.
- **Lernen und Anpassen**: Neue Begriffe, URLs, Charaktere und Themen gibst du direkt im Dashboard ein. Mit einem GitHub-Token (Einstellungen) werden sie in `config/interests.json` gespeichert und ein neuer Abruf startet sofort. Bewertungen landen in `docs/data/feedback.json`, damit sie auf allen Geräten gelten.

- **YouTube-Kanäle**: Kanäle trägst du im Dashboard ein, als `@name` oder als Link zum Kanal, und wählst je Kanal, wie die Videos ausgewertet werden. Die Auswertung steht danach als Zusammenfassung und Kernpunkte an der Karte, auf Deutsch, auch bei englischen Videos.
  - **Gemini**: Der Sammler gibt Gemini die YouTube-URL, Gemini schaut sich Bild und Ton direkt an. Dafür braucht das Repo das Secret `GEMINI_API_KEY` (Settings → Secrets and variables → Actions; Schlüssel gibt es unter https://aistudio.google.com/apikey). Ein Video von zehn Minuten braucht etwa 45.000 Token, bei Gemini Flash sind das wenige Cent.
  - **Parakeet (lokal)**: Ein kleiner Dienst bei dir zu Hause lädt den Ton, Parakeet schreibt mit, dein Ollama-Modell zieht die Infos heraus. Kostet nichts und bleibt auf deinen Geräten. Anleitung in [`transkript/README.md`](transkript/README.md).
  - **Nur auflisten**: Die Videos erscheinen ohne Auswertung.

  Ausgewertet werden nur Videos der letzten drei Tage, Gemini nimmt höchstens vier pro Abruf, Shorts bleiben draußen. Das lässt sich in `config/interests.json` ändern, zum Beispiel `"videos": {"maxPerRun": 4, "maxAgeDays": 3, "maxMinutes": 60, "shorts": false, "geminiModel": "gemini-flash-latest"}`.

- **Telegram**: Der frühere Bot in `bot/` ist seit dem 08.11.2026 abgeschaltet und wird nicht mehr gepflegt. Seine Aufgaben hat SK übernommen (privates Repo `sk-ki-os`): SK liest die News aus `docs/data/`, schreibt Bewertungen und trägt nach Knopfdruck neue Themen aus „News zu …“ in `config/interests.json` ein.

## Einrichtung

1. **Pages aktivieren:** Settings → Pages → Source: *Deploy from a branch*, Branch `main`, Ordner `/docs`.
2. **Actions erlauben:** Settings → Actions → General → Workflow permissions: *Read and write permissions*.
3. Einmal manuell starten: Actions → *News sammeln* → *Run workflow*.
4. Dashboard öffnen: `https://<dein-login>.github.io/sknews/`
5. Optional für Sync: Fine-grained Token nur für dieses Repo mit `Contents: Read and write` und `Actions: Read and write`, im Dashboard unter *Einstellungen* eintragen.

Hinweis: Bei einem privaten Repo braucht GitHub Pages ein bezahltes Konto. Die Seite selbst enthält keine Geheimnisse, der Token bleibt nur in deinem Browser.

## Gedanken und KI

Oben auf der Seite steht ein schlankes Suchfeld. Du schreibst eine Frage oder einen Gedanken, die KI versteht den Zusammenhang, sucht live nach aktuellen Artikeln (Bing News, sonst Google News), liest sie sichtbar durch und antwortet mit Kernaussage, Punkten und Quellen-Nummern. Darunter stehen die gefundenen Artikel mit Like-Knopf. Danach kannst du nachfragen, ein Thema wählen oder neu anlegen und festlegen, welche Suchanfragen ab jetzt stündlich mitlaufen.

- Ein Like (oder *Übernehmen*) legt das Gespräch in deiner Info-Welt ab: als Gedanke unter `notes` im Thema in `config/interests.json` und als Eintrag in `docs/data/wissen.json` (Verlauf, Antwort, Quellen, Likes). `wissen.json` wird nie gekürzt, damit sich aus der Historie später etwas ableiten lässt.
- Gelikte Artikel erscheinen 30 Tage im Feed ihres Themas und zählen fürs Lernen wie ein +.
- Der Sammler sucht pro Thema mit bis zu vier Suchanfragen aus den Gesprächen der letzten 60 Tage (`thought_searches` in `collector/collect.py`).
- In der Themenansicht ordnet die KI die aktuellen Artikel als „Lage“ ein, mit Quellen-Nummern statt nur Schlagzeilen.
- Zu jedem Gespräch und in jeder Themenansicht stehen klein bis zu 3 YouTube-Videos. Die Function holt Kandidaten aus der YouTube-Suche (ohne API-Schlüssel) und bewertet sie vor: Passung, Aufrufe, Alter und Länge zählen, Shorts und Clickbait verlieren, Kanäle aus dem Thema und gelikte Kanäle gewinnen. Aus den besten 10 wählt die KI höchstens 3 mit kurzer Begründung. Prüfen lässt sich die Suche mit `/api/ideen?yt=begriff`.
- Unter dem Feld zeigt ein Punkt, ob die KI erreichbar ist (`GET /api/ideen`).
- Gespeichert wird ins Repo nur mit GitHub-Token in den Einstellungen, sonst bleibt alles im Browser.

Die KI läuft als Cloudflare Pages Function (`functions/api/ideen.js`) mit Workers AI. Einmalig einrichten: Cloudflare → Workers & Pages → *sknews* → Settings → Bindings → *Add* → Workers AI, Variablenname `AI`, danach einen neuen Abruf starten (der Deploy nimmt die Bindung mit). Ohne Bindung, aber mit Secret `GEMINI_API_KEY` im Pages-Projekt, wird Gemini benutzt. Ohne KI funktioniert alles weiter, die Schlagworte zieht dann das Dashboard selbst heraus.

Achtung: Das Repo ist öffentlich, Gespräche, Likes und Gedanken sind es damit auch (wie Suchbegriffe und Bewertungen).

## Versionen

Jede Code-Änderung auf `main` (in der Regel ein gemergter PR) bekommt eine Version mit Git-Tag `vX.Y.Z` und GitHub-Release mit kurzen Notizen in Klartext. Die Patch-Nummer zählt bei jeder Änderung hoch, die mittlere bei größeren neuen Funktionen. Die Nummer steht auch unten im Dashboard (`docs/index.html`, Zeile „SK News v…“) und wird im selben Commit erhöht. Die stündlichen Daten-Commits der Action („Daten aktualisiert …“) bekommen keine Version.

## Lokal testen

```bash
python3 collector/collect.py
python3 -m http.server -d docs 8000
```

## Anmeldung über DataWrangler (Cloudflare Pages)

`functions/_middleware.js` schützt die ganze Seite auf Cloudflare Pages (Dashboard, Deals, `/api/*`)
mit dem Login von DataWrangler (dw.skzone.de). Ohne gültiges Cookie `skz_sso` geht es zu
`https://dw.skzone.de/api/auth/sso?next=…`, DW meldet an und schickt zurück. Die Funktion prüft
den Vermerk nur mit dem öffentlichen Schlüssel von DW. Wer rein darf, wird in DW verwaltet
(Konten, Einladungen); optional einschränkbar mit `SSO_USERS` bzw. `SSO_ROLES`.

Einrichtung:
1. DW: `SSO_COOKIE_DOMAIN=skzone.de` in die `.env`, Container neu starten.
2. `https://dw.skzone.de/api/auth/sso/key` öffnen, `publicKey` kopieren.
3. Cloudflare (Pages → sknews → Einstellungen → Variablen und Geheimnisse, Production):
   `DW_SSO_PUBLIC_KEY` = dieser Schlüssel. Optional `SSO_USERS`, `SSO_ROLES`,
   `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + KV-Bindung `USERS` (Meldung bei Anmeldungen).
4. Neu deployen.

Ohne `DW_SSO_PUBLIC_KEY` bleibt die Seite offen. GitHub Pages und die Rohdaten im öffentlichen
Repo sind davon nicht geschützt.
