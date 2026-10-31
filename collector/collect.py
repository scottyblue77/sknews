#!/usr/bin/env python3
"""Sammelt News zu den Themen aus config/interests.json und schreibt docs/data/*.json.

Quellen pro Thema:
  feeds       RSS/Atom-URLs oder normale Webseiten (der Feed wird dann automatisch gesucht)
  keywords    Suchbegriffe, abgefragt über Google News RSS
  characters  WoW-Charaktere (region/realm/name), abgefragt über die Raider.io-API
  youtube     YouTube-Kanäle ({"channel": "@handle", "analyse": "gemini|parakeet|off"}), siehe youtube.py

Nur Standardbibliothek, damit die GitHub Action nichts installieren muss.
"""
from __future__ import annotations

import hashlib
import html
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import youtube

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "interests.json"
DATA = ROOT / "docs" / "data"
VIDEOS = DATA / "videos"
UA = "Mozilla/5.0 (compatible; SKNews/1.0; +https://github.com)"
MAX_PER_SOURCE = 25
MAX_ARTICLES = 800
MAX_OG = 150

NOW = datetime.now(timezone.utc)


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def clean(text: str | None) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def norm_url(u: str) -> str:
    p = urllib.parse.urlsplit(u.strip())
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not k.lower().startswith(("utm_", "fbclid", "ocid"))]
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower().removeprefix("www."), p.path.rstrip("/"), urllib.parse.urlencode(q), ""))


def art_id(url: str) -> str:
    return hashlib.sha1(norm_url(url).encode()).hexdigest()[:16]


def title_key(t: str) -> str:
    return re.sub(r"[^a-z0-9äöüß]+", " ", t.lower()).strip()[:90]


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


IMG_RE = re.compile(r"<img[^>]+src=[\"']([^\"']+)", re.I)


def find_image(el) -> str:
    """Bild aus media:content, media:thumbnail, enclosure, News:Image oder einem <img> im HTML."""
    for c in el.iter():
        name = local(c.tag)
        url = c.get("url") or c.get("href") or ""
        if name in ("thumbnail", "content") and url and (c.get("medium") in (None, "image") and (c.get("type") or "image").startswith("image")):
            return url
        if name == "enclosure" and (c.get("type") or "").startswith("image") and url:
            return url
        if name == "Image" and (c.text or "").startswith("http"):
            return c.text.strip()
    for c in el.iter():
        if local(c.tag) in ("description", "encoded", "content", "summary") and c.text:
            m = IMG_RE.search(c.text)
            if m and not m.group(1).endswith((".gif", ".svg")):
                return html.unescape(m.group(1))
    return ""


def unwrap(link: str) -> str:
    """Bing-News-Links zeigen auf apiclick.aspx?...&url=<echte URL>."""
    if "bing.com/news/apiclick" in link:
        real = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query).get("url")
        if real:
            return real[0]
    return link


def parse_feed(raw: bytes) -> list[dict]:
    """RSS 2.0 und Atom. Gibt [{title, url, published, summary, source, image}] zurück."""
    root = ET.fromstring(raw)
    items = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        f = {}
        for c in el:
            f.setdefault(local(c.tag), c)
        title = clean(f["title"].text if "title" in f else "")
        link = ""
        if "link" in f:
            link = (f["link"].text or "").strip() or f["link"].get("href", "")
        for c in el:  # Atom: bevorzugt rel=alternate
            if local(c.tag) == "link" and c.get("rel", "alternate") == "alternate" and c.get("href"):
                link = c.get("href")
                break
        date = None
        for k in ("pubDate", "published", "updated", "date"):
            if k in f:
                date = parse_date(f[k].text)
                if date:
                    break
        sum_el = next((f[k] for k in ("description", "summary") if k in f), None)
        if sum_el is None and "content" in f and not f["content"].get("url"):
            sum_el = f["content"]
        summary = clean(sum_el.text if sum_el is not None else "")
        source = clean(f["source"].text) if "source" in f else (clean(f["Source"].text) if "Source" in f else "")
        if title and link:
            items.append({"title": title, "url": unwrap(link), "published": iso(date), "summary": summary[:280],
                          "source": source, "image": find_image(el)})
    return items


OG_RE = re.compile(r"<meta[^>]+(?:property|name)=[\"'](?:og:image|twitter:image)(?::src)?[\"'][^>]*>", re.I)


def og_image(url: str) -> str:
    raw = fetch(url, timeout=10)[:300_000].decode("utf-8", "ignore")
    for m in OG_RE.finditer(raw):
        c = re.search(r'content=["\']([^"\']+)', m.group(0), re.I)
        if c:
            return urllib.parse.urljoin(url, html.unescape(c.group(1)))
    return ""


def discover_feed(url: str, raw: bytes) -> str | None:
    """Sucht in einer HTML-Seite nach <link rel="alternate" type="application/rss+xml">."""
    text = raw[:200_000].decode("utf-8", "ignore")
    for m in re.finditer(r"<link[^>]+>", text, re.I):
        tag = m.group(0)
        if re.search(r"application/(rss|atom)\+xml", tag, re.I):
            href = re.search(r'href=["\']([^"\']+)', tag, re.I)
            if href:
                return urllib.parse.urljoin(url, html.unescape(href.group(1)))
    return None


def host(u: str) -> str:
    return urllib.parse.urlsplit(u).netloc.removeprefix("www.")


def from_feed(url: str, topic: str) -> list[dict]:
    raw = fetch(url)
    head = raw[:500].lstrip().lower()
    if head.startswith(b"<!doctype html") or b"<html" in head:
        feed = discover_feed(url, raw)
        if not feed:
            raise ValueError("kein RSS-Feed auf der Seite gefunden")
        log(f"  Feed gefunden: {feed}")
        raw = fetch(feed)
    items = parse_feed(raw)[:MAX_PER_SOURCE]
    for it in items:
        it.update(topic=topic, via=url, source=it["source"] or host(it["url"]) or host(url))
    return items


def from_keyword(kw: str, topic: str, lang: str, region: str) -> list[dict]:
    q = urllib.parse.quote(kw)
    url = f"https://www.bing.com/news/search?q={q}&format=rss&setmkt={lang}-{region}&setlang={lang}"
    items, err = [], None
    # Bing liefert bei vielen gleichzeitigen Abrufen gelegentlich kaputtes XML,
    # beim zweiten oder dritten Versuch klappt es meist. Google News hat keine Bilder.
    for attempt in range(3):
        if attempt:
            time.sleep(2 * attempt + random.random())
        try:
            items = parse_feed(fetch(url))[:MAX_PER_SOURCE]
            if items:
                break
            err = "leer"
        except Exception as e:
            err = e
    if not items:
        log(f"  Bing für {kw} fehlgeschlagen ({err}), nehme Google News")
        url = f"https://news.google.com/rss/search?q={urllib.parse.quote(kw + ' when:7d')}&hl={lang}&gl={region}&ceid={region}:{lang}"
        items = parse_feed(fetch(url))[:MAX_PER_SOURCE]
    for it in items:
        # Google-News-Titel enden auf " - Quelle"
        m = re.match(r"(.+) - ([^-]+)$", it["title"])
        if m and "news.google" in it["url"]:
            it["title"], src = m.group(1).strip(), m.group(2).strip()
            it["source"] = it["source"] or src
        it.update(topic=topic, via=f"Suche: {kw}", keyword=kw)
    return items


def from_character(ch: dict, topic: str, prev: dict) -> tuple[list[dict], dict]:
    region, realm, name = ch.get("region", "eu"), ch["realm"], ch["name"]
    fields = "mythic_plus_scores_by_season:current,raid_progression,gear"
    url = ("https://raider.io/api/v1/characters/profile?" +
           urllib.parse.urlencode({"region": region, "realm": realm, "name": name, "fields": fields}))
    d = json.loads(fetch(url))
    score = 0.0
    seasons = d.get("mythic_plus_scores_by_season") or []
    if seasons:
        score = round(float(seasons[0].get("scores", {}).get("all", 0)), 1)
    ilvl = (d.get("gear") or {}).get("item_level_equipped")
    raids = {k: v.get("summary") for k, v in (d.get("raid_progression") or {}).items()}
    snap = {"score": score, "ilvl": ilvl, "raids": raids}
    profile = d.get("profile_url") or f"https://raider.io/characters/{region}/{realm}/{name}"
    label = f"{d.get('name', name)} ({d.get('realm', realm)})"
    items = []
    key = f"{region}/{realm}/{name}".lower()
    old = prev.get(key)
    changes = []
    if old is None:
        changes.append(f"wird jetzt verfolgt: M+ {score}, Itemlevel {ilvl}")
    else:
        if score and score != old.get("score"):
            changes.append(f"M+-Wertung {old.get('score')} → {score}")
        if ilvl and old.get("ilvl") and ilvl > old["ilvl"]:
            changes.append(f"Itemlevel {old['ilvl']} → {ilvl}")
        for raid, prog in raids.items():
            if prog != (old.get("raids") or {}).get(raid):
                changes.append(f"Raid-Fortschritt {raid.replace('-', ' ').title()}: {prog}")
    if changes:
        stamp = hashlib.sha1("; ".join(changes).encode()).hexdigest()[:8]
        items.append({
            "title": f"{label}: " + "; ".join(changes),
            "url": f"{profile}#sknews-{stamp}",
            "published": iso(NOW), "summary": "", "source": "Raider.io",
            "topic": topic, "via": f"Charakter: {label}", "kind": "character",
        })
    return items, {key: snap}


def from_youtube(entry: dict, topic: str, cache: dict, opts: dict) -> list[dict]:
    """Neue Videos eines Kanals. Die Kanal-ID wird einmal aufgelöst und in youtube.json gemerkt."""
    ch = entry["channel"]
    known = cache.get(ch) or {}
    cid = known.get("id") or youtube.resolve(ch)
    title, videos = youtube.feed(cid)
    cache[ch] = {"id": cid, "title": title or known.get("title", "")}
    items = []
    for v in videos[:MAX_PER_SOURCE]:
        if v["shorts"] and not opts["shorts"]:
            continue
        items.append({
            "title": v["title"], "url": v["url"], "published": iso(parse_date(v.get("published"))),
            "summary": clean(v.get("description"))[:280], "source": title or ch, "image": youtube.thumbnail(v["id"]),
            "topic": topic, "via": f"YouTube: {ch}", "kind": "video",
            "video": {"id": v["id"], "channel": cid, "analyse": entry["analyse"]},
        })
    return items


def apply_analysis(a: dict, res: dict) -> None:
    a["summary"] = res.get("summary") or a.get("summary", "")
    a["points"] = res.get("points") or []
    if res.get("tags"):
        a["tags"] = res["tags"]
    a["analysis"] = {"by": res.get("by", ""), "model": res.get("model", ""), "at": res.get("at", ""), "lang": res.get("lang", "")}
    a["video"].pop("error", None)


def usable(a: dict, cutoff: datetime) -> bool:
    """Video ist jung genug und hat noch nicht zu oft versagt."""
    v = a["video"]
    return v.get("tries", 0) < 3 and v.get("waits", 0) < 24 and (parse_date(a["published"]) or NOW) >= cutoff


def analyse_videos(arts: list[dict], cfg: dict, opts: dict) -> dict:
    """Übernimmt fertige Auswertungen aus docs/data/videos/ und lässt neue Videos von Gemini auswerten."""
    VIDEOS.mkdir(parents=True, exist_ok=True)
    vids = [a for a in arts if a.get("kind") == "video" and a.get("video")]
    for a in vids:
        f = VIDEOS / f"{a['video']['id']}.json"
        if f.exists() and not a.get("analysis"):
            try:
                apply_analysis(a, json.loads(f.read_text("utf-8")))
            except Exception as e:
                log(f"FAIL Auswertung {f.name}: {e}")

    key, model = youtube.gemini_key(), opts["geminiModel"]
    cutoff = NOW - timedelta(days=float(opts["maxAgeDays"]))
    todo = [a for a in vids if a["video"].get("analyse") == "gemini" and not a.get("analysis") and usable(a, cutoff)]
    todo.sort(key=lambda a: a["published"], reverse=True)
    done, failed = 0, {}
    if key and todo:
        topics = {t["id"]: t for t in cfg["topics"]}

        def run(a):
            t = topics.get(a["topic"], {})
            meta = {"title": a["title"], "channel": a["source"], "topic": t.get("name", a["topic"]), "keywords": t.get("keywords", [])}
            return youtube.gemini_video(a["url"], meta, key, model, int(opts["maxMinutes"]))

        batch = todo[:int(opts["maxPerRun"])]
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = [(a, ex.submit(run, a)) for a in batch]
            for a, fut in futs:
                try:
                    res = fut.result()
                except Exception as e:
                    if "Gemini 403" in str(e):
                        # Livestream oder Premiere hat noch nicht begonnen (oder das Video ist privat):
                        # stündlich weiter versuchen, höchstens einen Tag lang, ohne Fehlversuch
                        a["video"]["waits"] = a["video"].get("waits", 0) + 1
                        log(f"     Gemini {a['url']}: noch nicht verfügbar")
                        continue
                    a["video"]["tries"] = a["video"].get("tries", 0) + 1
                    a["video"]["error"] = str(e)[:200]
                    failed[a["title"][:60]] = str(e)[:200]
                    log(f"FAIL Gemini {a['url']}: {e}")
                    continue
                res.update(id=a["video"]["id"], by="gemini", at=iso(NOW), title=a["title"], url=a["url"])
                (VIDEOS / f"{res['id']}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), "utf-8")
                apply_analysis(a, res)
                done += 1
                log(f"ok   Gemini {a['url']}: {res['tokens']['in']} Token rein, {res['tokens']['out']} raus")

    # Auswertungen von Videos, die nicht mehr in der Liste sind, wegräumen
    ids = {a["video"]["id"] for a in vids}
    for f in VIDEOS.glob("*.json"):
        if f.stem not in ids:
            f.unlink()

    waiting = lambda mode: sum(1 for a in vids if a["video"].get("analyse") == mode and not a.get("analysis") and usable(a, cutoff))
    if vids:
        log(f"Videos: {done} von Gemini ausgewertet, {waiting('gemini')} warten auf Gemini, {waiting('parakeet')} auf Parakeet")
    return {"geminiKey": bool(key), "analysed": sum(1 for a in vids if a.get("analysis")),
            "waiting": {"gemini": waiting("gemini"), "parakeet": waiting("parakeet")}, "errors": failed}


def main():
    cfg = json.loads(CONFIG.read_text("utf-8"))
    lang, region = cfg.get("language", "de"), cfg.get("region", "DE")
    keep_days = int(cfg.get("retentionDays", 14))
    DATA.mkdir(parents=True, exist_ok=True)
    old_path, char_path, status_path = DATA / "articles.json", DATA / "characters.json", DATA / "status.json"
    old = json.loads(old_path.read_text("utf-8")).get("articles", []) if old_path.exists() else []
    prev_chars = json.loads(char_path.read_text("utf-8")) if char_path.exists() else {}
    yt_path = DATA / "youtube.json"
    yt_cache = (json.loads(yt_path.read_text("utf-8")) if yt_path.exists() else {}).get("channels", {})
    yt_opts = youtube.settings(cfg)

    jobs = []
    for t in cfg["topics"]:
        for f in t.get("feeds", []):
            jobs.append((f"Feed {f}", lambda f=f, t=t: from_feed(f, t["id"])))
        for k in t.get("keywords", []):
            jobs.append((f"Suche {k}", lambda k=k, t=t: from_keyword(k, t["id"], lang, region)))
        for e in youtube.entries(t):
            jobs.append((f"YouTube {e['channel']}", lambda e=e, t=t: from_youtube(e, t["id"], yt_cache, yt_opts)))

    results, errors = [], {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(fn): name for name, fn in jobs}
        for fut, name in futs.items():
            try:
                got = fut.result()
                log(f"ok   {name}: {len(got)}")
                results.extend(got)
            except Exception as e:  # eine kaputte Quelle darf den Lauf nicht stoppen
                log(f"FAIL {name}: {e}")
                errors[name] = str(e)[:200]

    chars = dict(prev_chars)
    for t in cfg["topics"]:
        for ch in t.get("characters", []):
            name = f"Charakter {ch.get('name')}"
            try:
                got, snap = from_character(ch, t["id"], prev_chars)
                results.extend(got)
                chars.update(snap)
                log(f"ok   {name}: {len(got)} Änderungen")
            except Exception as e:
                log(f"FAIL {name}: {e}")
                errors[name] = str(e)[:200]

    # Zusammenführen: bekannte Artikel behalten ihr erstes fetchedAt, Dubletten über URL und Titel
    by_id: dict[str, dict] = {a["id"]: a for a in old}
    seen_titles = {title_key(a["title"]): a["id"] for a in old}
    added = 0
    for it in results:
        aid = art_id(it["url"])
        tk = title_key(it["title"])
        if aid in by_id or tk in seen_titles:
            ex_id = by_id.get(aid, {}).get("id") or seen_titles[tk]
            ex_art = by_id[ex_id]
            if it.get("keyword"):
                ex_art["matched"] = sorted(set(ex_art.get("matched", [])) | {it["keyword"]})
            continue
        art = {
            "id": aid, "title": it["title"], "url": it["url"], "source": it["source"],
            "topic": it["topic"], "published": it["published"] or iso(NOW), "fetchedAt": iso(NOW),
            "summary": it.get("summary", ""), "via": it.get("via", ""),
            "matched": [it["keyword"]] if it.get("keyword") else [],
            "image": it.get("image", ""),
        }
        if it.get("kind"):
            art["kind"] = it["kind"]
        if it.get("video"):
            art["video"] = it["video"]
        by_id[aid] = art
        seen_titles[tk] = aid
        added += 1

    # Fehlende Vorschaubilder über og:image der Artikelseite nachladen (begrenzt pro Lauf)
    todo = [a for a in sorted(by_id.values(), key=lambda a: a["published"], reverse=True)
            if not a.get("image") and not a.get("imgTried") and "news.google" not in a["url"] and a.get("kind") not in ("character", "video")][:MAX_OG]
    def enrich(a):
        try:
            a["image"] = og_image(a["url"])
        except Exception:
            pass
        a["imgTried"] = True
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(enrich, todo))
    log(f"og:image: {sum(1 for a in todo if a.get('image'))} von {len(todo)} gefunden")

    cutoff = NOW - timedelta(days=keep_days)
    topic_ids = {t["id"] for t in cfg["topics"]}  # Artikel gelöschter Themen fallen weg
    arts = [a for a in by_id.values() if a["topic"] in topic_ids and (parse_date(a["published"]) or NOW) >= cutoff]
    arts.sort(key=lambda a: a["published"], reverse=True)
    arts = arts[:MAX_ARTICLES]

    # Auswerte-Art aus der aktuellen Konfiguration übernehmen; entfernte Kanäle werden nicht mehr ausgewertet
    modes, unresolved = {}, set()
    for t in cfg["topics"]:
        for e in youtube.entries(t):
            cid = (yt_cache.get(e["channel"]) or {}).get("id")
            if cid:
                modes[(t["id"], cid)] = e["analyse"]
            else:
                unresolved.add(t["id"])  # Kanal gerade nicht erreichbar: bisherige Einstellung behalten
    for a in arts:
        if a.get("video"):
            k = (a["topic"], a["video"].get("channel"))
            if k in modes or a["topic"] not in unresolved:
                a["video"]["analyse"] = modes.get(k, "off")
    videos = analyse_videos(arts, cfg, yt_opts)

    old_path.write_text(json.dumps({"generatedAt": iso(NOW), "articles": arts}, ensure_ascii=False, indent=1), "utf-8")
    char_path.write_text(json.dumps(chars, ensure_ascii=False, indent=1), "utf-8")
    if yt_cache:
        yt_path.write_text(json.dumps({"channels": yt_cache}, ensure_ascii=False, indent=1), "utf-8")
    (DATA / "interests.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=1), "utf-8")
    status_path.write_text(json.dumps({"lastRun": iso(NOW), "added": added, "total": len(arts), "errors": errors, "videos": videos}, ensure_ascii=False, indent=1), "utf-8")
    log(f"{added} neu, {len(arts)} gesamt, {len(errors)} Fehler")


if __name__ == "__main__":
    main()
