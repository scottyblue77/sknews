#!/usr/bin/env python3
"""SKNews-Transkript-Dienst: wertet YouTube-Videos lokal aus.

Für Kanäle mit "analyse": "parakeet". Ablauf je Video:
  1. yt-dlp lädt nur den Ton (von einer Heim-IP, YouTube sperrt Rechenzentren wie GitHub)
  2. Parakeet TDT 0.6B v3 (onnx-asr, läuft auf der CPU) schreibt mit, 25 europäische Sprachen
  3. Ollama zieht die Infos heraus und schreibt sie auf Deutsch (ersatzweise Gemini, wenn GEMINI_API_KEY gesetzt ist)
  4. Das Ergebnis landet als docs/data/videos/<id>.json im Repo, der nächste Abruf übernimmt es ins Dashboard

Start: python worker.py          läuft dauerhaft, alle INTERVAL_MINUTES Minuten
       python worker.py --once   ein Durchgang
       python worker.py --video <URL oder ID>   ein einzelnes Video auswerten und ausgeben (Test, schreibt nichts)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "collector")]
import youtube  # noqa: E402  (liegt in collector/, im Container daneben)

REPO = os.environ.get("REPO", "scottyblue77/sknews")
BRANCH = os.environ.get("BRANCH", "main")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
LOCAL_REPO = os.environ.get("LOCAL_REPO", "").strip()  # Pfad zu einem Checkout: liest und schreibt dort statt über GitHub
OLLAMA_URL = os.environ.get("OLLAMA_URL", "").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.8:27b")
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "32768"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "900"))
PARAKEET_MODEL = os.environ.get("PARAKEET_MODEL", "nemo-parakeet-tdt-0.6b-v3")
PARAKEET_QUANT = os.environ.get("PARAKEET_QUANT", "int8") or None
# Rechenkerne für Parakeet. Vorgabe: die Hälfte, damit andere Dienste auf dem Rechner weiterlaufen.
PARAKEET_THREADS = int(os.environ.get("PARAKEET_THREADS") or max(1, (os.cpu_count() or 2) // 2))
INTERVAL = float(os.environ.get("INTERVAL_MINUTES", "30"))
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN", "3"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data" if Path("/data").is_dir() else HERE / ".daten"))
MAX_TRIES = 3
MAX_CHARS = 60_000  # so viel Transkript bekommt das Sprachmodell höchstens (etwa 15.000 Token)


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- Repo lesen und schreiben ----------

def gh(path: str, data: dict | None = None, method: str | None = None, raw: bool = False):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}", data=json.dumps(data).encode() if data is not None else None,
        method=method or ("PUT" if data is not None else "GET"),
        headers={"Authorization": f"Bearer {GITHUB_TOKEN}", "User-Agent": "sknews-transkript",
                 "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
                 **({"Content-Type": "application/json"} if data is not None else {})},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    return body if raw else (json.loads(body) if body else None)


def read_json(path: str):
    if LOCAL_REPO:
        p = Path(LOCAL_REPO) / path
        return json.loads(p.read_text("utf-8")) if p.exists() else None
    if GITHUB_TOKEN:
        try:
            return json.loads(gh(f"/contents/{path}?ref={BRANCH}", raw=True))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
    url = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read())


def existing_results() -> set[str]:
    """IDs der Videos, für die schon eine Auswertung im Repo liegt."""
    if LOCAL_REPO:
        d = Path(LOCAL_REPO) / "docs/data/videos"
        return {f.stem for f in d.glob("*.json")} if d.is_dir() else set()
    try:
        return {f["name"].removesuffix(".json") for f in gh(f"/contents/docs/data/videos?ref={BRANCH}") or []}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return set()
        raise


def write_result(res: dict) -> None:
    path = f"docs/data/videos/{res['id']}.json"
    text = json.dumps(res, ensure_ascii=False, indent=1)
    if LOCAL_REPO:
        p = Path(LOCAL_REPO) / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, "utf-8")
        return
    body = {"message": f"Video ausgewertet: {res['title'][:60]}", "branch": BRANCH,
            "content": base64.b64encode(text.encode()).decode()}
    try:  # gibt es die Datei schon (zweiter Durchgang), braucht GitHub ihren sha
        body["sha"] = gh(f"/contents/{path}?ref={BRANCH}")["sha"]
    except urllib.error.HTTPError:
        pass
    gh(f"/contents/{path}", body)


def start_collect() -> None:
    """Startet den Abruf, damit die Auswertung gleich im Dashboard steht und nicht erst zur vollen Stunde."""
    try:
        gh("/actions/workflows/collect.yml/dispatches", {"ref": BRANCH}, method="POST")
        log("Abruf gestartet")
    except urllib.error.HTTPError as e:
        log(f"Abruf nicht gestartet ({e.code}); der Token braucht dafür Actions: Read and write. Sonst erscheint es beim nächsten stündlichen Abruf.")


# ---------- Ton, Transkript, Auswertung ----------

def download_audio(url: str, folder: Path, max_minutes: int) -> tuple[Path, dict]:
    import yt_dlp

    opts = {"format": "bestaudio/best", "outtmpl": str(folder / "%(id)s.%(ext)s"),
            "quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as e:
            # Angekündigte Livestreams und Premieren: später noch einmal, zählt nicht als Fehlversuch
            if any(k in str(e) for k in ("live event will begin", "Premieres in", "Premiere will begin", "is_upcoming")):
                raise LookupError("Livestream oder Premiere hat noch nicht begonnen") from None
            raise
        if info.get("live_status") in ("is_upcoming", "is_live"):
            raise LookupError("Livestream läuft noch oder ist angekündigt")
        info = ydl.extract_info(url, download=True)
        src = Path(ydl.prepare_filename(info))
    wav = folder / "ton.wav"
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-threads", "1", "-y", "-i", str(src)]
    if max_minutes:
        cmd += ["-t", str(int(max_minutes) * 60)]
    subprocess.run(cmd + ["-ac", "1", "-ar", "16000", str(wav)], check=True)
    src.unlink(missing_ok=True)
    return wav, info


_asr = None


def transcribe(wav: Path) -> str:
    global _asr
    import onnx_asr

    if _asr is None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = PARAKEET_THREADS, 1
        log(f"Lade {PARAKEET_MODEL} ({PARAKEET_QUANT or 'voll'}, {PARAKEET_THREADS} Threads), beim ersten Mal wird es heruntergeladen")
        vad = onnx_asr.load_vad("silero", sess_options=so)
        _asr = onnx_asr.load_model(PARAKEET_MODEL, quantization=PARAKEET_QUANT, sess_options=so).with_vad(vad)
    # Mit VAD wird der Ton an Sprechpausen zerteilt, so gehen auch Videos über eine Stunde
    return " ".join(seg.text.strip() for seg in _asr.recognize(str(wav)) if seg.text.strip())


def extract(transcript: str, meta: dict) -> dict:
    text = transcript[:MAX_CHARS]
    if OLLAMA_URL:
        try:
            return youtube.ollama_text(text, meta, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT, OLLAMA_NUM_CTX)
        except Exception as e:
            log(f"Ollama fehlgeschlagen: {e}")
    key = youtube.gemini_key()
    if key:
        return youtube.gemini_text(text, meta, key, os.environ.get("GEMINI_MODEL", youtube.DEFAULTS["geminiModel"]))
    if OLLAMA_URL:
        raise RuntimeError("Ollama nicht erreichbar")
    # Ohne Sprachmodell bleibt wenigstens der Anfang des Transkripts
    return {"summary": transcript[:280].rsplit(" ", 1)[0] + " …", "points": [], "tags": [], "lang": "", "model": ""}


def analyse(url: str, meta: dict, max_minutes: int) -> dict:
    with tempfile.TemporaryDirectory(dir=DATA_DIR) as tmp:
        t0 = time.time()
        wav, info = download_audio(url, Path(tmp), max_minutes)
        t1 = time.time()
        transcript = transcribe(wav)
        t2 = time.time()
    if not transcript:
        raise RuntimeError("kein gesprochener Text gefunden")
    meta = {**meta, "channel": meta.get("channel") or info.get("channel") or "", "title": meta.get("title") or info.get("title") or ""}
    res = extract(transcript, meta)
    t3 = time.time()
    minutes = round((info.get("duration") or 0) / 60, 1)
    log(f"  {minutes} min Video: Ton {t1 - t0:.0f} s, Transkript {t2 - t1:.0f} s, Auswertung {t3 - t2:.0f} s, {len(transcript)} Zeichen")
    res["model"] = " + ".join(x for x in (PARAKEET_MODEL.removeprefix("nemo-"), res.get("model")) if x)
    res.update(by="parakeet", minutes=minutes, transcript=transcript,
               cut=bool(max_minutes and minutes > max_minutes))
    return res


# ---------- Durchgang ----------

def load_state() -> dict:
    p = DATA_DIR / "zustand.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def save_state(s: dict) -> None:
    (DATA_DIR / "zustand.json").write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")


def run_once() -> int:
    cfg = read_json("config/interests.json") or {"topics": []}
    opts = youtube.settings(cfg)
    max_age = float(os.environ.get("MAX_AGE_DAYS") or opts["maxAgeDays"])
    max_minutes = int(os.environ.get("MAX_MINUTES") or opts["maxMinutes"])
    arts = (read_json("docs/data/articles.json") or {}).get("articles", [])
    done = existing_results()
    state = load_state()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age)).strftime("%Y-%m-%dT%H:%M:%SZ")
    todo = [a for a in arts if a.get("kind") == "video" and (a.get("video") or {}).get("analyse") == "parakeet"
            and not a.get("analysis") and a["video"]["id"] not in done and (a.get("published") or "") >= cutoff
            and state.get(a["video"]["id"], {}).get("tries", 0) < MAX_TRIES]
    todo.sort(key=lambda a: a["published"], reverse=True)
    if not todo:
        log("Nichts zu tun")
        return 0
    log(f"{len(todo)} Videos warten, nehme {min(len(todo), MAX_PER_RUN)}")
    topics = {t["id"]: t for t in cfg.get("topics", [])}
    written = tried = 0
    for a in todo:
        if tried >= MAX_PER_RUN:
            break
        vid = a["video"]["id"]
        t = topics.get(a["topic"], {})
        meta = {"title": a["title"], "channel": a.get("source", ""), "topic": t.get("name", a["topic"]), "keywords": t.get("keywords", [])}
        log(f"Werte aus: {a['title'][:70]} ({a['url']})")
        try:
            res = analyse(a["url"], meta, max_minutes)
        except LookupError as e:
            log(f"  übersprungen: {e}")
            continue
        except Exception as e:
            tried += 1
            st = state.setdefault(vid, {})
            st["tries"] = st.get("tries", 0) + 1
            st["error"] = str(e)[:300]
            save_state(state)
            log(f"  Fehler ({st['tries']}. Versuch): {e}")
            continue
        tried += 1
        res.update(id=vid, at=now_iso(), title=a["title"], url=a["url"])
        write_result(res)
        state.pop(vid, None)
        save_state(state)
        written += 1
        log(f"  fertig: {res['summary'][:120]}")
    if written and not LOCAL_REPO:
        start_collect()
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="nur ein Durchgang")
    ap.add_argument("--video", help="ein Video testweise auswerten und ausgeben, schreibt nichts")
    ap.add_argument("--thema", default="", help="Thema für --video, z. B. SpaceX")
    args = ap.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.video:
        url = f"https://www.youtube.com/watch?v={args.video}" if youtube.VIDEO_ID_RE.match(args.video) else args.video
        res = analyse(url, {"title": "", "channel": "", "topic": args.thema or "allgemein"}, int(os.environ.get("MAX_MINUTES") or 60))
        res["transcript"] = res["transcript"][:600] + " …"
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return

    if not (LOCAL_REPO or GITHUB_TOKEN):
        sys.exit("GITHUB_TOKEN fehlt (oder LOCAL_REPO für einen lokalen Checkout).")
    where = LOCAL_REPO or REPO
    llm = f"Ollama {OLLAMA_MODEL} über {OLLAMA_URL}" if OLLAMA_URL else ("Gemini" if youtube.gemini_key() else "ohne Sprachmodell")
    log(f"SKNews-Transkript für {where}, Auswertung: {llm}, alle {INTERVAL:g} min")
    while True:
        try:
            run_once()
        except Exception as e:  # ein Fehler darf den Dienst nicht beenden
            log(f"Durchgang fehlgeschlagen: {e}")
        if args.once:
            break
        time.sleep(INTERVAL * 60)


if __name__ == "__main__":
    main()
