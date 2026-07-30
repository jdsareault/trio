"""Tests for structured confidence — the nth_send param, DB column, SSE payload,
and backward/forward-compat.

Covers:
  • nth_send accepts high/medium/low (case-insensitive), stores it on the row
  • absent / blank confidence stores NULL (no badge downstream)
  • an out-of-enum value is rejected (surfaces a typo, doesn't vanish)
  • the text-suffix convention ("... low") still works and is untouched
  • _message_event ships `confidence` (present value + None for a bare row)
  • ensure_ask_columns adds `confidence` to a DB that predates it (forward-compat)
  • a row missing the column entirely yields confidence=None, no crash
Usage: python tests/test-confidence.py
"""
import json
import sqlite3
import tempfile
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_conf_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def conf_of(mid):
    db = srv.get_db()
    try:
        return db.execute("SELECT confidence FROM messages WHERE id=?", (mid,)).fetchone()[0]
    finally:
        db.close()


def event_for(mid):
    db = srv.get_db()
    try:
        r = db.execute(
            "SELECT id, member_id, member_name, content, mentions, refs, bangs, "
            "choices, selection, reply_to, confidence, retracted_at, retraction_reason, "
            "edited_at, created_at FROM messages WHERE id=?", (mid,)).fetchone()
        return web._message_event(db, r)
    finally:
        db.close()


r = json.loads(srv.nth_connect(summary="t", name="Ann", channel="conftest"))
CH, ann = r["channel"], r["member_id"]

# ── param accepted + stored, case-insensitive ──
for raw, want in (("high", "high"), ("MEDIUM", "medium"), ("  Low ", "low")):
    mid = json.loads(srv.nth_send(channel=CH, member_id=ann, message="s", confidence=raw))["message_id"]
    check(f"confidence {raw!r} stored as {want!r}", conf_of(mid) == want)
    check(f"SSE payload carries confidence={want!r}", event_for(mid)["confidence"] == want)

# ── absent / blank → NULL, and SSE None ──
mid_none = json.loads(srv.nth_send(channel=CH, member_id=ann, message="no conf"))["message_id"]
check("absent confidence stores NULL", conf_of(mid_none) is None)
check("SSE payload confidence=None when absent", event_for(mid_none)["confidence"] is None)

mid_blank = json.loads(srv.nth_send(channel=CH, member_id=ann, message="blank", confidence="   "))["message_id"]
check("blank confidence stores NULL", conf_of(mid_blank) is None)

mid_expl_none = json.loads(srv.nth_send(channel=CH, member_id=ann, message="x", confidence=None))["message_id"]
check("explicit None stores NULL", conf_of(mid_expl_none) is None)

# ── out-of-enum rejected (typo surfaces, doesn't silently vanish) ──
bad = json.loads(srv.nth_send(channel=CH, member_id=ann, message="y", confidence="very-high"))
check("out-of-enum confidence is rejected", "error" in bad)

# ── backward-compat: the text-suffix convention still works untouched ──
mid_suffix = json.loads(srv.nth_send(
    channel=CH, member_id=ann, message="rebase clean. running tests. low"))["message_id"]
ev = event_for(mid_suffix)
check("text-suffix message still sends", ev["content"].endswith("low"))
check("text-suffix message keeps confidence=None (no structured field)", ev["confidence"] is None)

# ── forward-compat: ensure_ask_columns adds `confidence` to an old DB ──
old_db_path = Path(_tmp) / "old.db"
odb = sqlite3.connect(str(old_db_path))
odb.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, channel TEXT, member_id TEXT, "
            "member_name TEXT, content TEXT, mentions TEXT, created_at TEXT)")
odb.execute("CREATE TABLE members (id TEXT, channel TEXT, name TEXT)")
odb.execute("INSERT INTO messages (id, channel, member_id, content, mentions, created_at) "
            "VALUES (1, 'c', 'm', 'legacy row', '', '2026-01-01T00:00:00Z')")
odb.commit()
cols_before = [c[1] for c in odb.execute("PRAGMA table_info(messages)").fetchall()]
check("old DB has no confidence column before migration", "confidence" not in cols_before)
web.ensure_ask_columns(odb)
odb.commit()
cols_after = [c[1] for c in odb.execute("PRAGMA table_info(messages)").fetchall()]
check("ensure_ask_columns adds confidence column", "confidence" in cols_after)
# The legacy row now reads confidence = NULL, no crash.
odb.row_factory = sqlite3.Row
row = odb.execute("SELECT * FROM messages WHERE id=1").fetchone()
check("migrated legacy row has confidence=None", row["confidence"] is None)
odb.close()

# ── _message_event tolerates a row that never had the column (very old DB) ──
bare = sqlite3.connect(":memory:")
bare.row_factory = sqlite3.Row
bare.execute("CREATE TABLE messages (id INTEGER, member_id TEXT, member_name TEXT, content TEXT, "
             "mentions TEXT, created_at TEXT)")
bare.execute("INSERT INTO messages VALUES (1, 'm', 'M', 'hi', '', '2026-01-01T00:00:00Z')")
r0 = bare.execute("SELECT * FROM messages WHERE id=1").fetchone()
ev0 = web._message_event(bare, r0)
check("_message_event: missing confidence column yields None (no crash)", ev0["confidence"] is None)
bare.close()

print("")
print(("FAILED" if failures else "OK") + f" — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
