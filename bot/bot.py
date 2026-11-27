#!/usr/bin/env python3
"""SKNews-Telegram-Bot: beantwortet Fragen zu deinen News und zum Haus und merkt sich, was du ihm erzählst.

Läuft dauerhaft (z. B. als Docker-Container auf ZimaOS) und
  - holt alle SYNC_MINUTES die Dashboard-Daten (Artikel, Bewertungen, Interessen, WoW-Charaktere) aus dem Repo
    und legt sie in einer SQLite-Datenbank ab, die nie etwas vergisst,
  - fragt Telegram per Long Polling nach neuen Nachrichten (kein offener Port nötig),
  - lässt ein Sprachmodell mit Werkzeugen in diesem Gedächtnis suchen, Notizen anlegen und Artikel bewerten:
    ein lokales Modell über Ollama (OLLAMA_URL); Claude nur ohne OLLAMA_URL oder mit CLAUDE_FALLBACK=true,
  - schickt auf Wunsch jeden Morgen ein Briefing.

Konfiguration nur über Umgebungsvariablen, siehe bot/README.md.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import anthropic

from memory import Memory, now_iso

try:
    import heim  # Haus-Werkzeuge (Home Assistant, Logs, Netz), optional
except ImportError:
    heim = None

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
ALLOWED = {int(x) for x in os.environ.get("ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if x}
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("CLAUDE_EFFORT", "low")
DATA_URL = os.environ.get("SKNEWS_DATA_URL", "https://raw.githubusercontent.com/scottyblue77/sknews/main/docs/data").rstrip("/")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "scottyblue77/sknews")
DB_PATH = os.environ.get("DB_PATH", "/data/sknews.db")
SYNC_MINUTES = int(os.environ.get("SYNC_MINUTES", "30"))
BRIEFING_TIME = os.environ.get("BRIEFING_TIME", "")  # z. B. "07:30", leer = aus
OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/")  # z. B. http://192.168.1.50:11434, leer = nur Claude
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:12b")  # passt mit 32k Kontext in 12 GB VRAM, ruft Werkzeuge zuverlässig auf
OLLAMA_THINK = os.environ.get("OLLAMA_THINK", "false").lower() in ("1", "true", "yes", "ja")
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "16384"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "300"))
# Wie lange das Modell nach einer Anfrage im Grafikspeicher bleibt; danach ist die GPU wieder frei (z. B. für ComfyUI)
OLLAMA_KEEP_ALIVE = os.environ.get("OLLAMA_KEEP_ALIVE", "").strip() or "30m"
# Ollama versteht Zahlen (Sekunden, -1 = immer) nur als JSON-Zahl, Text nur mit Einheit ("30m", "24h")
OLLAMA_KEEP_ALIVE = int(OLLAMA_KEEP_ALIVE) if re.fullmatch(r"-?\d+", OLLAMA_KEEP_ALIVE) else OLLAMA_KEEP_ALIVE
HEIM_CLAUDE = os.environ.get("HEIM_CLAUDE", "false").lower() in ("1", "true", "yes", "ja")  # Haus-Daten auch an Claude?
# Mit OLLAMA_URL bleibt alles lokal: Fällt Ollama aus, sagt der Bot das, statt den Verlauf an Claude zu schicken.
CLAUDE_FALLBACK = os.environ.get("CLAUDE_FALLBACK", "false").lower() in ("1", "true", "yes", "ja")
TZ = ZoneInfo(os.environ.get("TZ", "Europe/Berlin"))
HISTORY_TURNS = 20  # Verlauf für Claude
# Kleine lokale Modelle rufen mit Verlauf oft keine Werkzeuge auf und antworten aus alten Nachrichten.
# Im Test (gemma4:12b, 7 Fragen hintereinander): ohne Verlauf 6/7 richtig, letzter Wortwechsel 4/7, 20 Nachrichten fast 0.
OLLAMA_HISTORY = int(os.environ.get("OLLAMA_HISTORY", "0"))
OLLAMA_HISTORY_CHARS = 300
UA = "SKNews-Bot/1.0"
WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]

# Modelle, die server-seitige Fallbacks bei Ablehnungen unterstützen
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}

mem = Memory(DB_PATH)
# Ohne Client kann nichts an Claude gehen, egal was im Code oder im Modell passiert
claude = anthropic.Anthropic() if os.environ.get("ANTHROPIC_API_KEY") and (not OLLAMA_URL or CLAUDE_FALLBACK) else None
HEIM = bool(heim and heim.ENABLED)
CTX = threading.local()  # Chat, für den gerade geantwortet wird (Rückfragen beim Schalten)


def log(*a):
    print(datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"), *a, file=sys.stderr, flush=True)


def http_json(url: str, data: dict | None = None, headers: dict | None = None, method: str | None = None, timeout: int = 30):
    body = json.dumps(data).encode() if data is not None else None
    h = {"User-Agent": UA, **({"Content-Type": "application/json"} if body else {}), **(headers or {})}
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


# ---------------------------------------------------------------- Telegram

def tg(method: str, **params):
    return http_json(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}", params)["result"]


def plain(text: str) -> str:
    """Telegram zeigt hier kein Markdown: **fett** und #-Überschriften als normalen Text ausgeben.
    __ bleibt, weil es in Pfaden und Namen wie __init__ vorkommt; ** innerhalb von Wörtern (x**2) auch."""
    text = re.sub(r"(?<![\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])", r"\1", text)
    return re.sub(r"(?m)^#{1,6}[ \t]+", "", text)


def send(chat_id: int, text: str) -> None:
    text = plain(text).strip() or "(keine Antwort)"
    while text:
        cut = len(text) if len(text) <= 4000 else (text.rfind("\n", 0, 4000) if text.rfind("\n", 0, 4000) > 1000 else 4000)
        tg("sendMessage", chat_id=chat_id, text=text[:cut], disable_web_page_preview=True)
        text = text[cut:].lstrip()


def ask_confirm(chat_id: int, text: str, token: str) -> None:
    tg("sendMessage", chat_id=chat_id, text=text, reply_markup={"inline_keyboard": [[
        {"text": "✅ Ausführen", "callback_data": f"ha:1:{token}"},
        {"text": "❌ Abbrechen", "callback_data": f"ha:0:{token}"},
    ]]})


def notify_all(text: str) -> None:
    for chat in ALLOWED:
        try:
            send(chat, text)
        except Exception as e:
            log("Meldung fehlgeschlagen:", e)


# ---------------------------------------------------------------- Daten aus dem Repo

def sync() -> str:
    arts = http_json(f"{DATA_URL}/articles.json", timeout=60).get("articles", [])
    new = mem.import_articles(arts)
    mem.import_feedback(http_json(f"{DATA_URL}/feedback.json") or {})
    mem.set_kv("interests", http_json(f"{DATA_URL}/interests.json"))
    try:
        mem.set_kv("characters", http_json(f"{DATA_URL}/characters.json"))
    except urllib.error.HTTPError:
        pass
    mem.set_kv("last_sync", now_iso())
    msg = f"{len(arts)} Artikel geladen, {new} neu im Gedächtnis"
    log("Sync:", msg)
    return msg


def sync_loop() -> None:
    while True:
        try:
            sync()
        except Exception as e:
            log("Sync fehlgeschlagen:", e)
        time.sleep(SYNC_MINUTES * 60)


def push_feedback(aid: str, patch: dict) -> str:
    """Schreibt eine Bewertung nach docs/data/feedback.json, damit das Dashboard sie auch kennt."""
    if not GITHUB_TOKEN:
        return "nur im Bot gespeichert (kein GITHUB_TOKEN gesetzt)"
    api = f"https://api.github.com/repos/{GITHUB_REPO}/contents/docs/data/feedback.json"
    hdr = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}
    for _ in range(3):
        try:
            cur = http_json(api + "?ref=main", headers=hdr)
            fb = json.loads(base64.b64decode(cur["content"]).decode() or "{}")
            fb[aid] = {**fb.get(aid, {}), **patch}
            content = base64.b64encode((json.dumps(fb, ensure_ascii=False, indent=2) + "\n").encode()).decode()
            http_json(api, {"message": "Bewertung per Telegram", "content": content, "branch": "main", "sha": cur["sha"]},
                      headers=hdr, method="PUT")
            return "auch im Dashboard gespeichert"
        except urllib.error.HTTPError as e:
            if e.code != 409:  # 409 = jemand anderes hat gleichzeitig geschrieben, nochmal versuchen
                return f"Dashboard-Sync fehlgeschlagen (GitHub {e.code})"
    return "Dashboard-Sync fehlgeschlagen (Konflikt)"


# ---------------------------------------------------------------- Werkzeuge für Claude

TOOLS = [
    {
        "name": "search_articles",
        "description": "Volltextsuche im Artikel-Gedächtnis (alle jemals gesammelten Artikel, auch ältere als 14 Tage). "
                       "Für Fragen wie 'Was gab es zu Starship?' oder 'Gab es letzten Monat was zu Tesla FSD?'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Suchbegriffe"},
                "topic": {"type": "string", "description": "Optional: Themen-ID (siehe get_preferences), z. B. wow, tesla, spacex, aktien, crypto"},
                "days": {"type": "integer", "description": "Optional: nur Artikel der letzten N Tage"},
                "limit": {"type": "integer", "description": "Anzahl Treffer, Standard 10, max 30"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "latest_news",
        "description": "Die neuesten Artikel, optional nur zu einem Thema. Für 'Was gibt's Neues?' und Briefings.",
        "input_schema": {
            "type": "object",
            "properties": {
                "topic": {"type": "string", "description": "Optional: Themen-ID"},
                "hours": {"type": "integer", "description": "Zeitraum in Stunden, Standard 24"},
                "limit": {"type": "integer", "description": "Anzahl, Standard 15, max 40"},
            },
        },
    },
    {
        "name": "get_preferences",
        "description": "Interessen (Themen mit IDs, Suchbegriffe, Gewichte), zuletzt gemochte und nicht gemochte Artikel, "
                       "WoW-Charakterdaten von Raider.io und Größe des Gedächtnisses.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "rate_article",
        "description": "Bewertet einen Artikel wie die +/- Knöpfe im Dashboard. Das Dashboard lernt daraus.",
        "input_schema": {
            "type": "object",
            "properties": {
                "article_id": {"type": "string"},
                "vote": {"type": "integer", "enum": [-1, 0, 1], "description": "1 = interessant, -1 = uninteressant, 0 = Bewertung entfernen"},
            },
            "required": ["article_id", "vote"],
        },
    },
    {
        "name": "remember",
        "description": "Speichert eine dauerhafte Notiz über den Nutzer (Vorlieben, Besitz, Pläne, Fakten). "
                       "Nutze das, wenn er etwas erzählt, das später nützlich ist, oder ausdrücklich 'merk dir' sagt.",
        "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "recall",
        "description": "Sucht in den gespeicherten Notizen. Ohne Suchbegriff kommen die neuesten.",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}},
    },
    {
        "name": "forget",
        "description": "Löscht eine Notiz anhand ihrer ID.",
        "input_schema": {"type": "object", "properties": {"note_id": {"type": "integer"}}, "required": ["note_id"]},
    },
]


def fmt_articles(rows: list[dict]) -> str:
    if not rows:
        return "Keine Artikel gefunden."
    out = []
    for a in rows:
        vote = {1: " [+ gemocht]", -1: " [- nicht gemocht]"}.get(a.get("vote") or 0, "")
        summary = (a.get("summary") or "")[:220]
        out.append(f"id={a['id']} | {a['published'][:16]} | {a['topic']} | {a['source']}{vote}\n"
                   f"  {a['title']}\n  {a['url']}" + (f"\n  {summary}" if summary else ""))
    return "\n".join(out)


def run_tool(name: str, inp: dict) -> str:
    if HEIM and name in heim.NAMES:
        return heim.run_tool(name, inp, getattr(CTX, "chat_id", 0), ask_confirm)
    if name == "search_articles":
        return fmt_articles(mem.search_articles(inp["query"], inp.get("topic"), inp.get("days"), min(inp.get("limit") or 10, 30)))
    if name == "latest_news":
        return fmt_articles(mem.latest(inp.get("topic"), inp.get("hours") or 24, min(inp.get("limit") or 15, 40)))
    if name == "get_preferences":
        interests = mem.get_kv("interests", {}) or {}
        topics = [{k: t.get(k) for k in ("id", "name", "weight", "keywords")} for t in interests.get("topics", [])]
        return json.dumps({"themen": topics, "bewertungen": mem.taste(), "wow_charaktere": mem.get_kv("characters", {}),
                           "gedaechtnis": mem.stats(), "letzte_synchronisierung": mem.get_kv("last_sync")},
                          ensure_ascii=False)
    if name == "rate_article":
        if not mem.article(inp["article_id"]):
            return f"Unbekannte Artikel-ID {inp['article_id']}"
        patch = mem.rate(inp["article_id"], inp["vote"])
        return "Gespeichert, " + push_feedback(inp["article_id"], patch)
    if name == "remember":
        return f"Notiz {mem.add_note(inp['text'])} gespeichert."
    if name == "recall":
        notes = mem.search_notes(inp.get("query") or "")
        return "\n".join(f"#{n['id']} ({n['created'][:10]}): {n['text']}" for n in notes) or "Keine Notizen."
    if name == "forget":
        return "Gelöscht." if mem.delete_note(inp["note_id"]) else "Keine Notiz mit dieser ID."
    return f"Unbekanntes Werkzeug {name}"


# ---------------------------------------------------------------- Claude

SYSTEM = """Du bist der persönliche News-Assistent von Sebastian im Telegram-Chat. Grundlage ist sein SKNews-Dashboard: \
ein Sammler holt stündlich Artikel zu seinen Themen (World of Warcraft inkl. seiner Charaktere, Tesla, SpaceX, Aktien, Crypto) \
und er bewertet sie mit + und -.

So arbeitest du:
- Antworte auf Deutsch, kurz und direkt wie in einem Chat. Beantworte die Frage zuerst, Details danach.
- Stütze Aussagen über Nachrichten auf die Artikel aus deinen Werkzeugen und nenne bei wichtigen Punkten den Link. \
Wenn nichts im Gedächtnis ist, sag das, statt etwas zu erfinden.
- Berücksichtige, was er mag und nicht mag (get_preferences, recall), und erwähne Uninteressantes nur, wenn er danach fragt.
- Erzählt er etwas Dauerhaftes über sich (z. B. welche Aktien er hält, was ihn nervt), speichere es mit remember.
- Sagt er, ein Artikel war gut oder schlecht, bewerte ihn mit rate_article.
- Telegram zeigt kein Markdown: keine Sternchen, keine Rauten, keine Tabellen. Nutze einfache Absätze, Spiegelstriche mit "•" \
und gelegentlich ein passendes Emoji. Links schreibst du als nackte URL.""" + (heim.SYSTEM if HEIM else "")

# Das lokale Modell bekommt immer alle Werkzeuge, Claude die Haus-Werkzeuge nur mit HEIM_CLAUDE
LOCAL_TOOLS = TOOLS + (heim.TOOLS if HEIM else [])
CLAUDE_TOOLS = TOOLS + (heim.TOOLS if HEIM and HEIM_CLAUDE else [])
CLAUDE_SYSTEM = SYSTEM if HEIM_CLAUDE or not HEIM else SYSTEM.replace(heim.SYSTEM, "\n\nHaus-Werkzeuge hast du gerade nicht, "
                                                                     "weil Hausdaten das Heimnetz nicht verlassen sollen. "
                                                                     "Sag das, wenn er nach dem Haus fragt.")


def call_tool(name: str, inp: dict) -> tuple[str, bool]:
    try:
        out, err = run_tool(name, inp), False
        getattr(CTX, "tools", []).append(name)  # nur erfolgreiche Aufrufe zählen
    except Exception as e:
        out, err = f"Fehler: {e}", True
    log(f"Werkzeug {name}({json.dumps(inp, ensure_ascii=False)[:120]})")
    return out, err


def ask_ollama(messages: list[dict]) -> str:
    """Lokales Modell über die Ollama-API, mit denselben Werkzeugen wie Claude."""
    tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                               "parameters": t["input_schema"]}} for t in LOCAL_TOOLS]
    messages = [{"role": "system", "content": SYSTEM}, *messages]
    for _ in range(10):
        resp = http_json(f"{OLLAMA_URL}/api/chat", {
            "model": OLLAMA_MODEL, "messages": messages, "tools": tools, "stream": False,
            "think": OLLAMA_THINK, "options": {"num_ctx": OLLAMA_NUM_CTX}, "keep_alive": OLLAMA_KEEP_ALIVE,
        }, timeout=OLLAMA_TIMEOUT)
        msg = resp["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            return (msg.get("content") or "").strip()
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            f = c["function"]
            args = f.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args or "{}")
            out, _ = call_tool(f["name"], args)
            messages.append({"role": "tool", "content": out, "tool_name": f["name"]})
    return "Das wurde mir zu verschachtelt, frag bitte etwas konkreter."


def ask_claude(messages: list[dict]) -> str:
    extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"} if MODEL in FALLBACK_MODELS else {}

    for _ in range(10):
        resp = claude.beta.messages.create(
            model=MODEL, max_tokens=16000, system=CLAUDE_SYSTEM, tools=CLAUDE_TOOLS, messages=messages,
            output_config={"effort": EFFORT}, cache_control={"type": "ephemeral"}, **extra,
        )
        if resp.stop_reason == "refusal":
            return "Dazu kann ich leider nichts sagen."
        uses = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses:
            return "\n".join(b.text for b in resp.content if b.type == "text").strip()
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for u in uses:
            out, err = call_tool(u.name, u.input)
            results.append({"type": "tool_result", "tool_use_id": u.id, "content": out, "is_error": err})
        messages.append({"role": "user", "content": results})
    return "Das wurde mir zu verschachtelt, frag bitte etwas konkreter."


LOKAL_AUS = (f"Das lokale Modell ({OLLAMA_MODEL}) antwortet gerade nicht. "
             "Läuft der PC mit Ollama? Versuch es gleich nochmal.")


class LokalFehler(Exception):
    """Das lokale Modell hat keine Antwort geliefert, und Claude ist als Ersatz nicht erlaubt. str() ist der Text für den Chat."""


class LokalNichtErreichbar(LokalFehler):
    """Ollama ist nicht erreichbar (PC aus, Netz, Timeout). Lohnt einen späteren neuen Versuch."""


def lokal_fehler(e: Exception) -> LokalFehler:
    if isinstance(e, urllib.error.HTTPError):  # Ollama läuft, meldet aber einen Fehler (z. B. Modell nicht geladen)
        try:
            detail = e.read()[:300].decode("utf-8", "replace")
        except Exception:
            detail = ""
        log(f"Ollama ({OLLAMA_MODEL}) meldet HTTP {e.code}:", detail or e.reason)
        if e.code >= 500:  # meist vorübergehend: GPU belegt (ComfyUI), Speicher knapp, Warteschlange voll
            return LokalNichtErreichbar(f"Ollama ist gerade überlastet (HTTP {e.code}). {detail or e.reason}".strip())
        return LokalFehler(f"Ollama meldet einen Fehler (HTTP {e.code}). {detail or e.reason}".strip())
    if isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, OSError)):
        log(f"Ollama ({OLLAMA_MODEL}) nicht erreichbar:", e)
        return LokalNichtErreichbar(LOKAL_AUS)
    log(f"Ollama ({OLLAMA_MODEL}) fehlgeschlagen:", traceback.format_exc())
    return LokalFehler(f"Das lokale Modell hat eine unbrauchbare Antwort geliefert ({type(e).__name__}). Frag bitte nochmal.")


def short_history(rows: list[dict]) -> list[dict]:
    """Verlauf fürs lokale Modell: die letzten OLLAMA_HISTORY Nachrichten (bis zur Nutzernachricht davor erweitert).
    Hat der Bot zuletzt etwas gefragt, kommt mindestens der letzte Wortwechsel mit, damit "Küche" als Antwort ankommt.
    Gekürzt wird bei Nutzernachrichten das Ende, bei Bot-Antworten der Anfang (die Rückfrage steht meist am Schluss)."""
    n = OLLAMA_HISTORY
    if rows and rows[-1]["role"] == "assistant" and rows[-1]["text"].rstrip().endswith("?"):
        n = max(n, 2)
    if n <= 0 or not rows:
        return []
    start = max(0, len(rows) - n)
    while start > 0 and rows[start]["role"] != "user":
        start -= 1
    out = []
    for m in rows[start:]:
        t, c = m["text"], OLLAMA_HISTORY_CHARS
        if len(t) > c:
            t = t[:c] + " …" if m["role"] == "user" else "… " + t[-c:]
        out.append({"role": m["role"], "content": t})
    return out


# "Merk dir, dass ..." / "Notier dir: ..." – aber nicht "merk dir das bitte nicht" oder nur "merk dir das"
MERK = re.compile(r"(?i)\b(?:merk|merke|notier|notiere)\s+dir\b[\s,:;-]*(.*)", re.S)
MERK_NICHT = re.compile(r"(?i)^(?:(?:das|es|bitte|mal|davon)\s+)*(?:nicht|nichts|bloß nicht|auf keinen fall)\b")
MERK_FUELL = {"das", "es", "bitte", "mal", "dass", "doch", "noch", "auch", "kurz", "folgendes"}


def merk_inhalt(text: str) -> str:
    """Was nach "merk dir" steht, falls es eine echte Notiz ist (mindestens drei Wörter, keine Verneinung, keine Frage)."""
    m = MERK.search(text)
    if not m or text.rstrip().endswith("?"):
        return ""
    rest = m.group(1).strip()
    if MERK_NICHT.match(rest):
        return ""
    words = re.findall(r"\w+", rest)
    while words and words[0].lower() in MERK_FUELL:
        words.pop(0)
    if len(words) < 3:
        return ""
    lead = re.match(r"(?i)^(?:(?:das|es|bitte|mal|doch|noch|auch|kurz|folgendes)\b[\s,:;-]*)*(?:dass\b\s*)?", rest)
    return rest[lead.end():].strip().rstrip(".!") if lead else rest


def schon_notiert(content: str) -> bool:
    """Gibt es schon eine Notiz mit fast denselben Wörtern?"""
    words = {w for w in re.findall(r"\w+", content.lower()) if len(w) > 2}
    if not words:
        return False
    for n in mem.search_notes(content, 5):
        other = {w for w in re.findall(r"\w+", n["text"].lower()) if len(w) > 2}
        if len(words & other) >= 0.8 * len(words):
            return True
    return False


def ask(chat_id: int, text: str, with_history: bool = True) -> str:
    """Fragt das lokale Modell (falls OLLAMA_URL gesetzt). Claude nur ohne OLLAMA_URL oder mit CLAUDE_FALLBACK.
    with_history=False: ohne Gesprächsverlauf (Briefing), damit das Modell frisch nachschaut."""
    CTX.chat_id = chat_id
    CTX.tools = []  # Werkzeuge, die in dieser Runde wirklich aufgerufen wurden
    now = datetime.now(TZ)
    stamp = f"{WEEKDAYS[now.weekday()]}, {now:%d.%m.%Y %H:%M}"
    hist = mem.history(chat_id, HISTORY_TURNS) if with_history else []
    current = {"role": "user", "content": f"[{stamp}]\n{text}"}
    messages: list[dict] = [{"role": m["role"], "content": m["text"]} for m in hist] + [current]

    answer = ""
    if OLLAMA_URL:
        try:
            answer = ask_ollama(short_history(hist) + [current])
        except Exception as e:
            if not claude:
                raise lokal_fehler(e) from e
            log(f"Ollama ({OLLAMA_MODEL}) fehlgeschlagen, nehme Claude:", e)
    if answer and OLLAMA_URL and not {"remember", "forget"} & set(CTX.tools):
        # Das kleine Modell sagt manchmal "gemerkt", ohne remember aufzurufen. Dann speichert der Code die Notiz
        # und sagt das sichtbar dazu, damit du sie mit /notizen prüfen und mit "vergiss Notiz n" löschen kannst.
        content = merk_inhalt(text)
        if content and not schon_notiert(content):
            nid = mem.add_note(content)
            log(f"Notiz {nid} vom Code gespeichert, das Modell hat remember ausgelassen")
            answer += f"\n\n📝 Notiz #{nid} gespeichert: {content} (/notizen zeigt alle)"
    if not answer:
        if not claude:
            answer = "Das lokale Modell hat nichts geantwortet."
        elif OLLAMA_URL and HEIM and not HEIM_CLAUDE:
            # Im Verlauf können Hausdaten aus früheren lokalen Antworten stehen: Claude bekommt nur die aktuelle Nachricht
            answer = ask_claude(messages[-1:])
        else:
            answer = ask_claude(messages)

    # Im Verlauf bleibt nur der reine Text, so bleibt jeder Aufruf klein und unabhängig
    mem.add_message(chat_id, "user", f"[{stamp}]\n{text}")
    mem.add_message(chat_id, "assistant", answer or "(keine Antwort)")
    return answer


BRIEFING_PROMPT = ("Mach mir mein Briefing: die wichtigsten Neuigkeiten der letzten 24 Stunden zu meinen Themen, "
                   "sortiert nach dem, was mich am meisten interessiert. Pro Thema höchstens drei Punkte mit Link, "
                   "Themen ohne Wichtiges lässt du weg. Wenn sich bei meinen WoW-Charakteren etwas getan hat, erwähne es.")


BRIEFING_TRIES = 6  # bei ausgeschaltetem Ollama-PC: eine Stunde lang alle 10 Minuten


def briefing_loop() -> None:
    hh, mm = (int(x) for x in BRIEFING_TIME.split(":"))
    # Das Datum des letzten Briefings überlebt Neustarts, sonst käme nach jedem Update ein zweites
    last = mem.get_kv("briefing_last")
    day, tries, ready = None, {}, {}  # tries[chat]: Fehlversuche heute, -1 = erledigt; ready: fertig, aber nicht gesendet
    while True:
        now = datetime.now(TZ)
        today = now.date().isoformat()
        if day != today:
            day, tries, ready = today, {}, {}
        if (now.hour, now.minute) >= (hh, mm) and last != today:
            retry = False

            def failed(chat: int, why: str, notice: str = "") -> None:
                """Fehlversuch zählen; nach BRIEFING_TRIES aufgeben und, wenn möglich, Bescheid sagen."""
                nonlocal retry
                tries[chat] = tries.get(chat, 0) + 1
                log(f"Briefing: {why} (Versuch {tries[chat]} von {BRIEFING_TRIES})")
                if tries[chat] < BRIEFING_TRIES:
                    retry = True
                    return
                tries[chat] = -1
                if notice:
                    try:
                        send(chat, f"☀️ Heute kein Briefing. {notice}")
                    except Exception as e2:
                        log("Meldung fehlgeschlagen:", e2)

            for chat in ALLOWED:
                if tries.get(chat) == -1:
                    continue
                text = ready.get(chat)
                if text is None:
                    try:
                        text = ask(chat, BRIEFING_PROMPT, with_history=False)
                    except LokalNichtErreichbar as e:
                        failed(chat, f"lokales Modell nicht erreichbar: {e}", str(e))
                        continue
                    except LokalFehler as e:
                        tries[chat] = -1  # z. B. Modell nicht vorhanden: neu versuchen hilft nicht
                        log("Briefing fehlgeschlagen:", e)
                        try:
                            send(chat, f"☀️ Heute kein Briefing. {e}")
                        except Exception as e2:
                            log("Meldung fehlgeschlagen:", e2)
                        continue
                    except Exception as e:  # z. B. Claude-API überlastet
                        failed(chat, f"fehlgeschlagen: {e}", f"Fehler: {e}")
                        continue
                try:
                    send(chat, text)
                    tries[chat] = -1
                    ready.pop(chat, None)
                except Exception as e:  # Telegram kurz weg: fertigen Text später nochmal schicken
                    ready[chat] = text
                    failed(chat, f"Senden fehlgeschlagen: {e}")
            if retry:
                time.sleep(600)
                continue
            last = today
            mem.set_kv("briefing_last", today)
        time.sleep(30)


# ---------------------------------------------------------------- Nachrichten

HELP = """Frag mich einfach, zum Beispiel:
• Was gibt's Neues bei SpaceX?
• Gab es diese Woche was zu Tesla FSD?
• Merk dir, dass ich Bitcoin halte.
• Der Artikel über den Hotfix war gut.

Befehle:
/briefing  Zusammenfassung der letzten 24 Stunden
/notizen  was ich mir über dich gemerkt habe
/neu  Gesprächsverlauf vergessen (Notizen bleiben)
/sync  Dashboard-Daten jetzt neu laden"""

HELP_HEIM = """

Haus und Heimnetz:
• Ist irgendwo ein Fenster offen?
• Wie warm ist es in der Küche?
• Gab es heute Fehler in den Logs?
• Mach die Poolpumpe aus. (ich frage vorher mit Knopf nach)
/status  welche Geräte gerade erreichbar sind"""


def handle(msg: dict) -> None:
    chat_id, text = msg["chat"]["id"], (msg.get("text") or "").strip()
    if chat_id not in ALLOWED:
        if not ALLOWED:
            send(chat_id, f"Hallo! Deine Chat-ID ist {chat_id}. Trag sie als ALLOWED_CHAT_IDS beim Bot ein "
                          "und starte ihn neu, dann rede ich mit dir.")
        log("Nachricht von unbekanntem Chat", chat_id, "ignoriert")
        return
    if not text:
        send(chat_id, "Ich verstehe bisher nur Text.")
        return
    cmd = text.split()[0].split("@")[0].lower()
    if cmd in ("/start", "/hilfe", "/help"):
        send(chat_id, HELP + (HELP_HEIM if HEIM else ""))
    elif cmd == "/status" and HEIM and heim.HOSTS:
        send(chat_id, heim.network_status())
    elif cmd == "/neu":
        mem.clear_history(chat_id)
        send(chat_id, "Okay, neues Gespräch. Notizen und Artikel bleiben gespeichert.")
    elif cmd == "/sync":
        send(chat_id, sync())
    elif cmd == "/notizen":
        send(chat_id, run_tool("recall", {}))
    else:
        tg("sendChatAction", chat_id=chat_id, action="typing")
        try:
            answer = ask(chat_id, BRIEFING_PROMPT, with_history=False) if cmd == "/briefing" else ask(chat_id, text)
        except LokalFehler as e:
            answer = str(e)
        send(chat_id, answer)


def handle_button(cb: dict) -> None:
    """Knopfdruck auf eine Rückfrage zum Schalten."""
    msg = cb.get("message") or {}
    chat_id = msg.get("chat", {}).get("id")
    if chat_id not in ALLOWED or not HEIM or not (cb.get("data") or "").startswith("ha:"):
        tg("answerCallbackQuery", callback_query_id=cb["id"])
        return
    _, yes, token = cb["data"].split(":", 2)
    tg("answerCallbackQuery", callback_query_id=cb["id"], text="Moment ...")
    try:
        result = heim.confirm(token, chat_id, yes == "1")
    except Exception as e:
        result = f"Fehler beim Schalten: {e}"
    log("Knopf:", result.splitlines()[0])
    tg("editMessageText", chat_id=chat_id, message_id=msg["message_id"], text=f"{msg.get('text', '')}\n\n{result}")


def main() -> None:
    if not TELEGRAM_TOKEN:
        sys.exit("Fehlende Umgebungsvariable: TELEGRAM_TOKEN")
    if not OLLAMA_URL and not claude:
        sys.exit("Fehlende Umgebungsvariable: ANTHROPIC_API_KEY oder OLLAMA_URL")
    me = tg("getMe")
    models = ([f"{OLLAMA_MODEL} über {OLLAMA_URL}"] if OLLAMA_URL else []) + ([MODEL] if claude else [])
    log(f"Bot @{me['username']} gestartet, Modell {' mit Fallback '.join(models)}"
        + (" (nur lokal, kein Claude)" if OLLAMA_URL and not claude else "")
        + f", erlaubte Chats: {sorted(ALLOWED) or 'noch keine'}")
    if HEIM:
        log(f"Haus-Werkzeuge: {', '.join(sorted(heim.NAMES))}" + ("" if HEIM_CLAUDE else " (nur lokales Modell)"))
    elif heim is None:
        log("heim.py fehlt, Haus-Werkzeuge aus (BOT_SOURCE-Dateiliste in docker-compose.yml prüfen)")
    threading.Thread(target=sync_loop, daemon=True).start()
    if BRIEFING_TIME:
        threading.Thread(target=briefing_loop, daemon=True).start()
    if HEIM and heim.HOSTS and heim.WATCH_MINUTES > 0:
        threading.Thread(target=heim.watch_loop, args=(notify_all, log), daemon=True).start()

    offset = 0
    while True:
        try:
            # Long Polling: Telegram hält die Anfrage bis zu 50 s offen, bis eine Nachricht kommt
            updates = http_json(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates",
                                {"offset": offset, "timeout": 50, "allowed_updates": ["message", "callback_query"]}, timeout=70)["result"]
        except Exception as e:
            log("Telegram nicht erreichbar:", e)
            time.sleep(10)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            if "callback_query" in u:
                try:
                    handle_button(u["callback_query"])
                except Exception:
                    log(traceback.format_exc())
            elif "message" in u:
                try:
                    handle(u["message"])
                except Exception:
                    log(traceback.format_exc())
                    try:
                        send(u["message"]["chat"]["id"], "Da ist etwas schiefgegangen, versuch es gleich nochmal.")
                    except Exception:
                        pass


if __name__ == "__main__":
    main()
