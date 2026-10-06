# SKNews

Persönliches News-Dashboard für World of Warcraft (inkl. eigener Charaktere), Tesla, SpaceX, Aktien und Crypto. Es sortiert die News danach, was dich interessiert, und lernt aus deinen Bewertungen.

## So funktioniert es

- **Sammler** (`collector/collect.py`): läuft stündlich als GitHub Action. Er liest `config/interests.json` und holt
  - RSS/Atom-Feeds (bei normalen Webseiten wird der Feed automatisch gesucht),
  - Google-News-Ergebnisse für jeden Suchbegriff,
  - Raider.io-Daten für deine WoW-Charaktere (M+-Wertung, Itemlevel, Raid-Fortschritt; jede Änderung wird zu einer Meldung).

  Ergebnis landet in `docs/data/`. Artikel älter als 14 Tage fallen raus.
- **Dashboard** (`docs/index.html`): statische Seite auf GitHub Pages. Ranking = Frische × Themen-Gewicht + Treffer deiner Suchbegriffe + gelernte Gewichte aus deinen Bewertungen (+ / −, gelesen, ausgeblendet). Bei jedem Artikel steht, warum er oben ist.
- **Lernen und Anpassen**: Neue Begriffe, URLs, Charaktere und Themen gibst du direkt im Dashboard ein. Mit einem GitHub-Token (Einstellungen) werden sie in `config/interests.json` gespeichert und ein neuer Abruf startet sofort. Bewertungen landen in `docs/data/feedback.json`, damit sie auf allen Geräten gelten.

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
