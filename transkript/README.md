# SKNews-Transkript: YouTube-Videos lokal auswerten

Dieser Dienst kümmert sich um die YouTube-Kanäle, die im Dashboard auf **Parakeet (lokal)** stehen. Er lädt von jedem neuen Video nur den Ton, schreibt mit Parakeet mit und lässt dein Ollama-Modell die wichtigen Infos herausziehen, auf Deutsch, auch wenn das Video englisch ist. Das Ergebnis schreibt er ins Repo, und beim nächsten Abruf erscheinen Zusammenfassung und Kernpunkte an der Karte im Dashboard.

Er läuft bei dir zu Hause und nicht in der GitHub Action, weil YouTube Downloads von Rechenzentren wie GitHub meist sperrt. Von deinem Heimanschluss aus klappt das ohne Probleme, und Ton, Transkript und Auswertung bleiben auf deinen Geräten.

## So arbeitet er

1. Alle 30 Minuten liest er `docs/data/articles.json` und sucht Videos von Parakeet-Kanälen, für die es noch keine Auswertung gibt. Ausgewertet werden nur Videos der letzten drei Tage, höchstens drei pro Durchgang.
2. **yt-dlp** lädt die Tonspur, **ffmpeg** macht daraus 16 kHz Mono.
3. **Parakeet TDT 0.6B v3** (über `onnx-asr`, läuft auf der CPU) schreibt mit. Das Modell kann 25 europäische Sprachen, darunter Deutsch und Englisch. Der Ton wird an Sprechpausen zerteilt, so gehen auch Videos über eine Stunde.
4. **Ollama** bekommt das Transkript und liefert eine Zusammenfassung in zwei, drei Sätzen, drei bis sieben Kernpunkte und Stichwörter. Antwortet Ollama nicht und ist `GEMINI_API_KEY` gesetzt, übernimmt Gemini diesen Schritt (nur der Text, kein Video).
5. Das Ergebnis landet als `docs/data/videos/<Video-ID>.json` im Repo, samt vollem Transkript. Danach stößt der Dienst einen Abruf an, damit es gleich im Dashboard steht.

Angekündigte Livestreams und Premieren überspringt er, bis sie gelaufen sind. Scheitert ein Video dreimal, lässt er es liegen.

## Installation auf ZimaOS

1. ZimaOS-Oberfläche öffnen → App Store → **+** → **Eigene App installieren** → **Importieren**.
2. Den Inhalt von [`docker-compose.yml`](docker-compose.yml) einfügen.
3. `GITHUB_TOKEN` und `OLLAMA_URL` eintragen. Der Token aus dem Dashboard passt, wenn er *Contents* und *Actions* mit *Read and write* hat.
4. Installieren. Beim ersten Start installiert der Container ffmpeg und die Python-Pakete und lädt beim ersten Video das Parakeet-Modell (rund 700 MB). Das dauert ein paar Minuten, danach geht es schneller.

Logs: `docker logs -f sknews-transkript`. Dort steht pro Video, wie lange Download, Mitschreiben und Auswertung gedauert haben.

## Einstellungen

| Variable | Bedeutung | Standard |
|---|---|---|
| `GITHUB_TOKEN` | Token mit *Contents* und *Actions: Read and write* | Pflicht |
| `REPO` | Repository | `scottyblue77/sknews` |
| `OLLAMA_URL` | Ollama-Server, z. B. `http://192.168.1.50:11434` | leer = Gemini oder nur Transkriptanfang |
| `OLLAMA_MODEL` | Modell für die Auswertung | `qwen3.8:27b` |
| `OLLAMA_NUM_CTX` | Kontextlänge in Token | `32768` |
| `GEMINI_API_KEY` | Ersatz, wenn Ollama nicht antwortet | leer = aus |
| `PARAKEET_THREADS` | Rechenkerne fürs Mitschreiben | halbe Kernzahl |
| `PARAKEET_MODEL` | Spracherkennung, siehe `onnx-asr` | `nemo-parakeet-tdt-0.6b-v3` |
| `PARAKEET_QUANT` | `int8` ist kleiner und schneller, leer = volle Genauigkeit | `int8` |
| `INTERVAL_MINUTES` | Abstand der Durchgänge | `30` |
| `MAX_PER_RUN` | Videos pro Durchgang | `3` |
| `MAX_MINUTES` | Längere Videos werden nur bis hier mitgeschrieben | aus `config/interests.json`, sonst `60` |
| `MAX_AGE_DAYS` | Ältere Videos werden nicht mehr ausgewertet | aus `config/interests.json`, sonst `3` |

Der Dienst läuft mit niedriger Priorität (`nice`) und nutzt für Parakeet nur so viele Kerne wie in `PARAKEET_THREADS` eingestellt. Home Assistant und die anderen Dienste auf der Zima bleiben so flüssig.

## Ohne Docker, z. B. auf dem Mac

```bash
pip install -r transkript/requirements.txt   # ffmpeg muss installiert sein (brew install ffmpeg)
GITHUB_TOKEN=... OLLAMA_URL=http://localhost:11434 python transkript/worker.py
```

Zum Ausprobieren, ohne etwas ins Repo zu schreiben:

```bash
python transkript/worker.py --video https://www.youtube.com/watch?v=... --thema SpaceX
```

Mit `LOCAL_REPO=/pfad/zum/checkout` liest und schreibt der Dienst in einem lokalen Checkout statt über GitHub, und `--once` macht genau einen Durchgang.
