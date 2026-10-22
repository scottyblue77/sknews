# SKNews-Bot für Telegram

Ein Telegram-Bot, mit dem du am Handy mit deinen SKNews-Daten redest: „Was gibt's Neues bei SpaceX?“, „Gab es letzten Monat was zu Tesla FSD?“, „Merk dir, dass ich Bitcoin halte.“ Claude beantwortet die Fragen und greift dabei auf das Gedächtnis des Bots zu.

## Das Gedächtnis

Der Bot hält eine SQLite-Datenbank (`/data/sknews.db`) mit Volltextsuche:

- **Artikel:** Alle 30 Minuten lädt er `docs/data/articles.json` aus dem Repo. Was einmal drin ist, bleibt drin, auch wenn das Dashboard Artikel nach 14 Tagen wegwirft. So findet er auch Monate später noch etwas.
- **Bewertungen:** Er übernimmt deine + / − aus dem Dashboard. Sagst du im Chat „der Artikel war gut“, bewertet er ihn. Mit `GITHUB_TOKEN` landet die Bewertung auch im Dashboard.
- **Notizen:** Erzählst du ihm etwas Dauerhaftes über dich, speichert er es und berücksichtigt es später.
- **Gesprächsverlauf:** Die letzten 20 Nachrichten, damit Rückfragen funktionieren. `/neu` löscht ihn, Notizen bleiben.

Die Datenbank liegt nur auf deinem Gerät. Claude bekommt bei jeder Frage nur die Treffer, die es gerade braucht.

## Was du brauchst

1. **Telegram-Bot-Token:** In Telegram `@BotFather` öffnen, `/newbot` schicken, Namen vergeben. Du bekommst einen Token wie `123456:ABC...`.
2. **Claude-API-Key:** Auf https://console.anthropic.com einen API-Key anlegen und etwas Guthaben aufladen. Abgerechnet wird nach Nutzung.
3. **Optional, GitHub-Token:** Damit Bewertungen aus Telegram auch im Dashboard landen. Fine-grained Token nur für `sknews` mit *Contents: Read and write* (derselbe wie im Dashboard reicht).

## Installation auf ZimaOS

1. ZimaOS-Oberfläche öffnen → App Store → **+** (oben rechts) → **Eigene App installieren** → **Importieren**.
2. Den Inhalt von [`docker-compose.yml`](docker-compose.yml) einfügen.
3. `TELEGRAM_TOKEN` und `ANTHROPIC_API_KEY` eintragen, `ALLOWED_CHAT_IDS` erst einmal leer lassen. Installieren.
4. In Telegram deinem Bot `/start` schreiben. Er antwortet mit deiner Chat-ID.
5. Die App in ZimaOS bearbeiten, die Zahl bei `ALLOWED_CHAT_IDS` eintragen und speichern. Ab jetzt antwortet der Bot nur dir.

Die Datenbank liegt unter `/DATA/AppData/sknews-bot`. Der Container lädt den Bot-Code bei jedem Start frisch aus dem Repo, ein Neustart bringt also Updates mit.

Alternativ per SSH auf der Zima: Ordner mit `docker-compose.yml` anlegen, Werte eintragen, `docker compose up -d`. Logs: `docker logs -f sknews-bot`.

## Einstellungen

| Variable | Bedeutung | Standard |
|---|---|---|
| `TELEGRAM_TOKEN` | Token von @BotFather | Pflicht |
| `ANTHROPIC_API_KEY` | Claude-API-Key | Pflicht, außer `OLLAMA_URL` ist gesetzt |
| `ALLOWED_CHAT_IDS` | Chat-IDs, mit denen der Bot redet, kommagetrennt | leer = niemand |
| `GITHUB_TOKEN` | Bewertungen ins Dashboard zurückschreiben | leer = nur im Bot |
| `BRIEFING_TIME` | Uhrzeit für das tägliche Briefing, z. B. `07:30` | aus |
| `TZ` | Zeitzone | `Europe/Berlin` |
| `OLLAMA_URL` | Ollama-Server für ein lokales Modell, z. B. `http://192.168.1.50:11434` | leer = nur Claude |
| `OLLAMA_MODEL` | Lokales Modell | `qwen3.8:27b` |
| `OLLAMA_THINK` | Denkmodus des lokalen Modells; `true` ist gründlicher, aber viel langsamer | `false` |
| `OLLAMA_NUM_CTX` | Kontextlänge in Token | `16384` |
| `OLLAMA_TIMEOUT` | Sekunden, bevor auf Claude ausgewichen wird | `300` |
| `CLAUDE_MODEL` | Claude-Modell | `claude-opus-5-5` |
| `CLAUDE_EFFORT` | Denkaufwand `low` bis `max`; höher = gründlicher und teurer | `low` |
| `SYNC_MINUTES` | Wie oft die Dashboard-Daten geladen werden | `30` |
| `HA_URL` / `HA_TOKEN` | Home Assistant und Langzeit-Token, siehe unten | leer = aus |
| `HA_ALLOWED_DOMAINS` | Was geschaltet werden darf | `light,switch,climate,cover,fan,media_player,scene,script,input_boolean,button,vacuum` |
| `LOKI_URL` | Loki für die Log-Suche | leer = aus |
| `HEIM_HOSTS` | Geräte für Erreichbarkeit, `Name=host:port,...` | leer = aus |
| `WATCH_MINUTES` | Abstand der Ausfall-Prüfung, `0` = keine Meldungen | `5` |
| `HEIM_CLAUDE` | Haus-Werkzeuge auch für Claude (sonst nur lokales Modell) | `false` |

## Lokales Modell (Ollama)

Mit `OLLAMA_URL` beantwortet ein Modell auf deinem eigenen Rechner die Fragen, mit denselben Werkzeugen wie Claude. Antwortet es nicht (Rechner aus, Timeout), springt Claude ein, sofern `ANTHROPIC_API_KEY` gesetzt ist.

1. Auf dem Ollama-Rechner: `ollama pull qwen3.8:27b`
2. Ollama muss im Netzwerk erreichbar sein (`OLLAMA_HOST=0.0.0.0`). Test von der Zima: `curl http://192.168.1.50:11434/api/tags`
3. `OLLAMA_URL` beim Bot eintragen und neu starten. Im Log steht dann `Modell qwen3.8:27b über ... mit Fallback claude-opus-5-5`.

## Haus und Heimnetz

Mit den Variablen oben wird der Bot auch zum Haus-Assistenten. Du fragst einfach im selben Chat:

- „Ist irgendwo ein Fenster offen?“, „Wie warm ist es in der Küche?“, „Wann lief die Poolpumpe heute?“ (Home Assistant)
- „Gab es heute Fehler?“, „Was sagt das Log von n8n?“ (Loki)
- „Ist die CCU3 erreichbar?“ oder `/status` (Erreichbarkeit aller Geräte aus `HEIM_HOSTS`)
- „Mach die Poolpumpe aus.“ Der Bot schaltet nie direkt. Er schickt eine Rückfrage mit den Knöpfen **Ausführen** und **Abbrechen**, erst dein Druck schaltet. Rückfragen verfallen nach 10 Minuten.

Von sich aus meldet er sich, wenn ein Gerät aus `HEIM_HOSTS` zweimal hintereinander nicht antwortet, und wenn es wieder da ist.

**Datenschutz:** Hausdaten gehen nur an das lokale Modell. Fällt Ollama aus, antwortet Claude zu News weiter, sagt beim Haus aber, dass es keinen Zugriff hat. Mit `HEIM_CLAUDE=true` darf auch Claude ran.

**Einrichtung Home Assistant:**

1. In HA unter Einstellungen → Personen einen neuen Benutzer „KI-Agent“ anlegen, **ohne** Administrator-Rechte.
2. Als dieser Benutzer anmelden, Profil → Sicherheit → Langzeit-Zugriffstoken erstellen.
3. Token als `HA_TOKEN` eintragen, `HA_URL` auf `http://192.168.1.17:8123`.
4. Bei Bedarf `HA_ALLOWED_DOMAINS` enger fassen. Schlösser und Alarmanlage sind absichtlich nicht dabei.

**Wichtig beim Update:** In der ZimaOS-App muss in der Startzeile auch `heim.py` geladen werden (siehe aktuelle `docker-compose.yml`). Fehlt sie, läuft der Bot weiter wie bisher und schreibt einen Hinweis ins Log.

## Befehle im Chat

- `/briefing`: Zusammenfassung der letzten 24 Stunden
- `/notizen`: was der Bot sich über dich gemerkt hat
- `/neu`: Gesprächsverlauf vergessen
- `/sync`: Dashboard-Daten sofort neu laden
- `/status`: welche Geräte im Heimnetz gerade erreichbar sind

Alles andere schreibst du einfach als normale Nachricht.

## Lokal testen

```bash
cd bot
pip install -r requirements.txt
TELEGRAM_TOKEN=... ANTHROPIC_API_KEY=... DB_PATH=./sknews.db python bot.py
```
