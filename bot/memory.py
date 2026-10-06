"""Gedächtnis des SKNews-Bots: SQLite-Datenbank mit Volltextsuche.

Tabellen:
  articles  jeder Artikel, den der Sammler je geliefert hat (bleibt auch nach den 14 Tagen erhalten)
  feedback  Bewertungen (+1/-1, gelesen, ausgeblendet), gespiegelt aus docs/data/feedback.json
  notes     Dinge, die du dem Bot im Chat erzählst
  messages  der letzte Chatverlauf pro Telegram-Chat
  kv        Kleinkram (Interessen, Charaktere, Zeitpunkt der letzten Synchronisierung)
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, title TEXT, url TEXT, source TEXT, topic TEXT,
  published TEXT, summary TEXT, matched TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  id UNINDEXED, title, summary, source, topic, matched, tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, vote INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, read INTEGER DEFAULT 0, at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  text, content='notes', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, role TEXT, text TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fts_query(text: str) -> str:
    """Macht aus freiem Text eine tolerante FTS5-Abfrage (Wörter mit ODER, Präfixsuche)."""
    words = [w for w in re.findall(r"\w+", text.lower()) if len(w) > 1]
    return " OR ".join(f'"{w}"*' for w in words[:12])


class Memory:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(SCHEMA)

    # ---------- Synchronisierung mit den Dashboard-Daten ----------

    def import_articles(self, articles: list[dict]) -> int:
        new = 0
        with self.lock, self.db:
            for a in articles:
                if not a.get("id") or not a.get("title"):
                    continue
                exists = self.db.execute("SELECT 1 FROM articles WHERE id=?", (a["id"],)).fetchone()
                row = (a["id"], a["title"], a.get("url", ""), a.get("source", ""), a.get("topic", ""),
                       a.get("published") or a.get("fetchedAt") or "", a.get("summary", ""),
                       ", ".join(a.get("matched") or []))
                self.db.execute("INSERT OR REPLACE INTO articles VALUES (?,?,?,?,?,?,?,?)", row)
                self.db.execute("DELETE FROM articles_fts WHERE id=?", (a["id"],))
                self.db.execute("INSERT INTO articles_fts(id,title,summary,source,topic,matched) VALUES (?,?,?,?,?,?)",
                                (row[0], row[1], row[6], row[3], row[4], row[7]))
                new += not exists
        return new

    def import_feedback(self, fb: dict) -> None:
        """Übernimmt Bewertungen aus dem Repo; der jeweils neuere Eintrag gewinnt (wie im Dashboard)."""
        with self.lock, self.db:
            for aid, f in (fb or {}).items():
                cur = self.db.execute("SELECT at FROM feedback WHERE id=?", (aid,)).fetchone()
                if cur and (cur["at"] or "") >= (f.get("at") or ""):
                    continue
                self.db.execute("INSERT OR REPLACE INTO feedback VALUES (?,?,?,?,?)",
                                (aid, f.get("vote", 0), int(bool(f.get("hidden"))), int(bool(f.get("read"))), f.get("at", "")))

    def set_kv(self, k: str, v) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, json.dumps(v, ensure_ascii=False)))

    def get_kv(self, k: str, default=None):
        with self.lock:
            r = self.db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(r["v"]) if r else default

    # ---------- Artikel ----------

    def _rows(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def search_articles(self, query: str, topic: str | None = None, days: int | None = None, limit: int = 10) -> list[dict]:
        q = fts_query(query)
        if not q:
            return self.latest(topic=topic, hours=(days or 3) * 24, limit=limit)
        sql = ("SELECT a.*, COALESCE(f.vote,0) AS vote FROM articles_fts s JOIN articles a ON a.id=s.id "
               "LEFT JOIN feedback f ON f.id=a.id WHERE articles_fts MATCH ?")
        args: list = [q]
        if topic:
            sql += " AND a.topic=?"
            args.append(topic)
        if days:
            sql += " AND a.published>=?"
            args.append((datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        sql += " ORDER BY bm25(articles_fts) - (julianday(a.published) - julianday('now')) * 0.3 LIMIT ?"
        args.append(limit)
        return self._rows(sql, args)

    def latest(self, topic: str | None = None, hours: int = 24, limit: int = 15) -> list[dict]:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
        sql = ("SELECT a.*, COALESCE(f.vote,0) AS vote FROM articles a LEFT JOIN feedback f ON f.id=a.id "
               "WHERE a.published>=? AND COALESCE(f.hidden,0)=0")
        args: list = [since]
        if topic:
            sql += " AND a.topic=?"
            args.append(topic)
        sql += " ORDER BY a.published DESC LIMIT ?"
        args.append(limit)
        return self._rows(sql, args)

    def article(self, aid: str) -> dict | None:
        rows = self._rows("SELECT * FROM articles WHERE id=?", (aid,))
        return rows[0] if rows else None

    def rate(self, aid: str, vote: int) -> dict:
        at = now_iso()
        with self.lock, self.db:
            self.db.execute("INSERT INTO feedback(id,vote,at) VALUES (?,?,?) "
                            "ON CONFLICT(id) DO UPDATE SET vote=excluded.vote, at=excluded.at", (aid, vote, at))
        return {"vote": vote, "at": at}

    def taste(self, limit: int = 15) -> dict:
        liked = self._rows("SELECT a.title, a.topic FROM feedback f JOIN articles a ON a.id=f.id "
                           "WHERE f.vote>0 ORDER BY f.at DESC LIMIT ?", (limit,))
        disliked = self._rows("SELECT a.title, a.topic FROM feedback f JOIN articles a ON a.id=f.id "
                              "WHERE f.vote<0 ORDER BY f.at DESC LIMIT ?", (limit,))
        return {"gemocht": liked, "nicht_gemocht": disliked}

    def stats(self) -> dict:
        r = self._rows("SELECT COUNT(*) n, MIN(published) first FROM articles")[0]
        return {"artikel": r["n"], "seit": r["first"], "notizen": self._rows("SELECT COUNT(*) n FROM notes")[0]["n"]}

    # ---------- Notizen ----------

    def add_note(self, text: str) -> int:
        with self.lock, self.db:
            return self.db.execute("INSERT INTO notes(text,created) VALUES (?,?)", (text, now_iso())).lastrowid

    def search_notes(self, query: str = "", limit: int = 20) -> list[dict]:
        q = fts_query(query)
        if not q:
            return self._rows("SELECT * FROM notes ORDER BY id DESC LIMIT ?", (limit,))
        return self._rows("SELECT n.* FROM notes_fts s JOIN notes n ON n.id=s.rowid WHERE notes_fts MATCH ? "
                          "ORDER BY bm25(notes_fts) LIMIT ?", (q, limit))

    def delete_note(self, nid: int) -> bool:
        with self.lock, self.db:
            return self.db.execute("DELETE FROM notes WHERE id=?", (nid,)).rowcount > 0

    # ---------- Chatverlauf ----------

    def add_message(self, chat_id: int, role: str, text: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT INTO messages(chat_id,role,text,at) VALUES (?,?,?,?)", (chat_id, role, text, now_iso()))

    def history(self, chat_id: int, limit: int = 20) -> list[dict]:
        rows = self._rows("SELECT role, text FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?", (chat_id, limit))
        rows.reverse()
        # Der Verlauf muss mit einer Nutzernachricht beginnen
        while rows and rows[0]["role"] != "user":
            rows.pop(0)
        return rows

    def clear_history(self, chat_id: int) -> None:
        with self.lock, self.db:
            self.db.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
