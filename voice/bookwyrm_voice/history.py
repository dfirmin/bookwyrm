"""Conversation history for the app: every call and typed chat, in ~/.bookwyrm/history.db.

A conversation's id is its Hermes session id, so reopening one and typing (or calling) carries on
the same Hermes session: Bookwyrm remembers the thread, not just this list. Hermes keeps its own
long-term memory separately; this store is only what the app shows.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from .config import data_dir

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id       TEXT PRIMARY KEY,         -- the Hermes session id
    kind     TEXT NOT NULL,            -- 'call' | 'chat': how it started
    title    TEXT NOT NULL,
    started  REAL NOT NULL,
    updated  REAL NOT NULL,
    reason   TEXT                      -- why Bookwyrm called, when it did
);
CREATE TABLE IF NOT EXISTS messages (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    conv  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role  TEXT NOT NULL,               -- 'user' | 'assistant'
    text  TEXT NOT NULL,
    at    REAL NOT NULL,
    via   TEXT NOT NULL                -- 'voice' | 'text'
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, id);
"""


def _title(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= 60 else text[:57].rsplit(" ", 1)[0] + "…"


class History:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "history.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(_SCHEMA)
        self._lock = threading.Lock()

    def add(self, conv: str, kind: str, role: str, text: str, via: str, reason: str | None = None):
        text = text.strip()
        if not text:
            return
        now = time.time()
        with self._lock, self._db:
            row = self._db.execute("SELECT title FROM conversations WHERE id = ?", (conv,)).fetchone()
            if row is None:
                title = _title(text) if role == "user" else ("Bookwyrm called" if reason else "Call")
                self._db.execute(
                    "INSERT INTO conversations (id, kind, title, started, updated, reason) VALUES (?,?,?,?,?,?)",
                    (conv, kind, title, now, now, reason))
            elif role == "user" and row["title"] in ("Call", "Bookwyrm called"):
                # Name a call after the first thing the caller asked, not "Call".
                self._db.execute("UPDATE conversations SET title = ? WHERE id = ?", (_title(text), conv))
            self._db.execute("UPDATE conversations SET updated = ? WHERE id = ?", (now, conv))
            self._db.execute("INSERT INTO messages (conv, role, text, at, via) VALUES (?,?,?,?,?)",
                             (conv, role, text, now, via))

    def conversations(self, limit: int = 200) -> list[dict]:
        rows = self._db.execute(
            """SELECT c.*, (SELECT text FROM messages m WHERE m.conv = c.id ORDER BY m.id DESC LIMIT 1) AS preview,
                      (SELECT COUNT(*) FROM messages m WHERE m.conv = c.id) AS count,
                      (SELECT COUNT(*) FROM messages m WHERE m.conv = c.id AND m.via = 'voice') AS voice
               FROM conversations c ORDER BY c.updated DESC LIMIT ?""", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def messages(self, conv: str) -> list[dict]:
        rows = self._db.execute("SELECT role, text, at, via FROM messages WHERE conv = ? ORDER BY id", (conv,))
        return [dict(r) for r in rows.fetchall()]

    def get(self, conv: str) -> dict | None:
        row = self._db.execute("SELECT * FROM conversations WHERE id = ?", (conv,)).fetchone()
        return dict(row) if row else None

    def rename(self, conv: str, title: str):
        with self._lock, self._db:
            self._db.execute("UPDATE conversations SET title = ? WHERE id = ?", (_title(title), conv))

    def delete(self, conv: str):
        with self._lock, self._db:
            self._db.execute("DELETE FROM conversations WHERE id = ?", (conv,))


def context_text(message) -> str:
    """The plain text of a Pipecat context message (string or list-of-parts content)."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""
