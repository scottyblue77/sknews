"""YouTube-Kanäle als Quelle: Kanal auflösen, neue Videos lesen, Videos auswerten.

Wird vom Sammler (GitHub Action) und vom lokalen Transkript-Dienst (transkript/worker.py)
benutzt. Nur Standardbibliothek.

Auswertung je Kanal (Feld "analyse"):
  gemini    Gemini schaut das Video direkt über die YouTube-URL an (GEMINI_API_KEY nötig)
  parakeet  der lokale Transkript-Dienst lädt den Ton, Parakeet schreibt mit, Ollama wertet aus
  off       Videos erscheinen nur in der Liste

Ergebnisse liegen als docs/data/videos/<videoId>.json und werden beim nächsten Lauf
in die Artikel übernommen (summary, points, analysis).
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
MODES = ("gemini", "parakeet", "off")
CHANNEL_ID_RE = re.compile(r"^UC[\w-]{22}$")
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

DEFAULTS = {
    "maxPerRun": 4,          # höchstens so viele Gemini-Auswertungen pro Lauf
    "maxAgeDays": 3,         # ältere Videos werden nur gelistet, nicht mehr ausgewertet
    "maxMinutes": 60,        # längere Videos werden nur bis hier ausgewertet
    "geminiModel": "gemini-flash-latest",
    "shorts": False,         # Shorts mitnehmen
}


def settings(cfg: dict) -> dict:
    return {**DEFAULTS, **(cfg.get("videos") or {})}


def entries(topic: dict) -> list[dict]:
    """Kanal-Einträge eines Themas; ein reiner String zählt als {"channel": s, "analyse": "gemini"}."""
    out = []
    for e in topic.get("youtube") or []:
        if isinstance(e, str):
            e = {"channel": e}
        ch = str(e.get("channel") or "").strip()
        if ch:
            mode = e.get("analyse") if e.get("analyse") in MODES else "gemini"
            out.append({"channel": ch, "analyse": mode})
    return out


def _get(url: str, timeout: int = 20) -> bytes:
    # Die Cookies überspringen die Einwilligungsseite, die YouTube in der EU sonst zeigt.
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8", "Cookie": "SOCS=CAI; CONSENT=YES+1",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def channel_url(ch: str) -> str:
    """Akzeptiert @handle, UC-ID oder eine beliebige Kanal-URL."""
    ch = ch.strip()
    if CHANNEL_ID_RE.match(ch):
        return f"https://www.youtube.com/channel/{ch}"
    if ch.startswith("@"):
        return "https://www.youtube.com/" + urllib.parse.quote(ch)
    if not re.match(r"^https?://", ch, re.I):
        ch = "https://" + ch
    return ch


def resolve(ch: str) -> str:
    """Liefert die Kanal-ID (UC…) für @handle, Kanal-URL oder ID."""
    ch = ch.strip()
    if CHANNEL_ID_RE.match(ch):
        return ch
    m = re.search(r"/channel/(UC[\w-]{22})", ch) or re.search(r"channel_id=(UC[\w-]{22})", ch)
    if m:
        return m.group(1)
    text = _get(channel_url(ch))[:1_500_000].decode("utf-8", "ignore")
    for pat in (r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"',
                r'feeds/videos\.xml\?channel_id=(UC[\w-]{22})',
                r'"externalId":"(UC[\w-]{22})"',
                r'"channelId":"(UC[\w-]{22})"'):
        m = re.search(pat, text)
        if m:
            return m.group(1)
    raise ValueError("Kanal nicht gefunden")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def feed(channel_id: str) -> tuple[str, list[dict]]:
    """Die letzten 15 Videos eines Kanals aus dem öffentlichen RSS-Feed. Gibt (Kanalname, Videos) zurück."""
    raw = _get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
    root = ET.fromstring(raw)
    title = ""
    videos = []
    for el in root:
        name = _local(el.tag)
        if name == "title":
            title = (el.text or "").strip()
        if name != "entry":
            continue
        v = {"description": ""}
        for c in el.iter():
            n = _local(c.tag)
            if n == "videoId":
                v["id"] = (c.text or "").strip()
            elif n == "title" and "title" not in v:
                v["title"] = (c.text or "").strip()
            elif n == "published":
                v["published"] = (c.text or "").strip()
            elif n == "description":
                v["description"] = (c.text or "").strip()
            elif n == "link" and c.get("rel", "alternate") == "alternate" and "url" not in v:
                v["url"] = c.get("href", "")
        if v.get("id") and v.get("title"):
            v["shorts"] = "/shorts/" in (v.get("url") or "")
            v["url"] = f"https://www.youtube.com/watch?v={v['id']}"
            videos.append(v)
    return title, videos


def thumbnail(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


# ---------- Auswertung ----------

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "2 bis 3 Sätze auf Deutsch: worum es geht und was neu ist"},
        "points": {"type": "array", "items": {"type": "string"},
                   "description": "3 bis 7 konkrete Kernaussagen auf Deutsch, mit Zahlen, Namen, Daten"},
        "tags": {"type": "array", "items": {"type": "string"}, "description": "bis zu 5 Stichwörter"},
        "lang": {"type": "string", "description": "Sprache des Videos als ISO-Code, z. B. en oder de"},
    },
    "required": ["summary", "points", "lang"],
}


def prompt(title: str, channel: str, topic: str, keywords: list[str], source: str) -> str:
    focus = f" Achte besonders auf: {', '.join(keywords)}." if keywords else ""
    return (
        f"{source} stammt aus dem YouTube-Video „{title}“ vom Kanal {channel} (Thema: {topic}). "
        "Ziehe die Informationen heraus, die für jemanden wichtig sind, der News zu diesem Thema verfolgt: "
        "Ankündigungen, Zahlen, Termine, Änderungen, Einschätzungen mit Begründung. "
        "Lass Werbung, Sponsoren, Begrüßung und Aufrufe zum Abonnieren weg." + focus +
        " Schreibe auf Deutsch, auch wenn das Video eine andere Sprache hat. "
        "Antworte nur mit JSON nach diesem Schema: summary (2 bis 3 Sätze), points (3 bis 7 Kernaussagen), "
        "tags (bis zu 5 Stichwörter), lang (Sprache des Videos)."
    )


def parse_result(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    d = json.loads(m.group(0) if m else text)
    points = [str(p).strip() for p in (d.get("points") or []) if str(p).strip()][:8]
    return {
        "summary": str(d.get("summary") or "").strip(),
        "points": points,
        "tags": [str(t).strip() for t in (d.get("tags") or []) if str(t).strip()][:5],
        "lang": str(d.get("lang") or "").strip()[:5],
    }


def gemini(parts: list[dict], key: str, model: str, timeout: int = 300, low_res: bool = False) -> dict:
    gen = {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.2}
    if low_res:
        gen["mediaResolution"] = "MEDIA_RESOLUTION_LOW"  # Bild grob, Ton voll: reicht für den Inhalt, kostet ein Drittel
    body = {"contents": [{"parts": parts}], "generationConfig": gen}
    req = urllib.request.Request(
        GEMINI_URL.format(model=model), data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "ignore")
        try:
            msg = json.loads(msg)["error"]["message"]
        except Exception:
            pass
        raise RuntimeError(f"Gemini {e.code}: {msg[:200]}") from None
    cands = d.get("candidates") or []
    if not cands or not cands[0].get("content", {}).get("parts"):
        raise RuntimeError(f"Gemini ohne Antwort ({(cands[0].get('finishReason') if cands else d.get('promptFeedback'))})")
    text = "".join(p.get("text", "") for p in cands[0]["content"]["parts"] if not p.get("thought"))
    usage = d.get("usageMetadata") or {}
    out = parse_result(text)
    out["tokens"] = {"in": usage.get("promptTokenCount", 0), "out": usage.get("candidatesTokenCount", 0)}
    out["model"] = d.get("modelVersion") or model
    return out


def gemini_video(url: str, meta: dict, key: str, model: str, max_minutes: int) -> dict:
    """Gemini liest Bild und Ton direkt von YouTube, ohne Download."""
    video = {"file_data": {"file_uri": url, "mime_type": "video/*"}}
    if max_minutes:
        video["video_metadata"] = {"end_offset": f"{int(max_minutes) * 60}s"}
    text = prompt(meta["title"], meta["channel"], meta["topic"], meta.get("keywords") or [], "Das Video")
    return gemini([video, {"text": text}], key, model, low_res=True)


def gemini_text(transcript: str, meta: dict, key: str, model: str) -> dict:
    text = prompt(meta["title"], meta["channel"], meta["topic"], meta.get("keywords") or [], "Das folgende Transkript")
    return gemini([{"text": text + "\n\nTranskript:\n" + transcript}], key, model)


def ollama_text(transcript: str, meta: dict, url: str, model: str, timeout: int = 600, num_ctx: int = 32768) -> dict:
    text = prompt(meta["title"], meta["channel"], meta["topic"], meta.get("keywords") or [], "Das folgende Transkript")
    body = {
        "model": model, "stream": False, "think": False, "format": SCHEMA,
        "options": {"num_ctx": num_ctx, "temperature": 0.2},
        "messages": [{"role": "user", "content": text + "\n\nTranskript:\n" + transcript}],
    }
    req = urllib.request.Request(url.rstrip("/") + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    out = parse_result(d["message"]["content"])
    out["model"] = model
    return out


def gemini_key() -> str:
    return os.environ.get("GEMINI_API_KEY", "").strip()
