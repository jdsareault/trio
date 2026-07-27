"""Tests for self-reported model tags on members (trio_connect model=…).

Verifies the model tier is stored, normalized, returned in the connect roster,
and surfaced by the web _fetch_roster. Usage: python tests/test-model-tags.py
"""
import json
import tempfile
import sys
import shutil
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


_tmp = tempfile.mkdtemp(prefix="nth_model_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def member_row(channel, mid):
    db = srv.get_db()
    try:
        return db.execute("SELECT model FROM members WHERE id=? AND channel=?",
                          (mid, channel)).fetchone()
    finally:
        db.close()


# connect with a model → stored + returned in roster
r = json.loads(srv.nth_connect(summary="t", name="Opus", channel="modeltest", model="Opus"))
mid = r["member_id"]
check("connect: model stored (lowercased)", member_row("modeltest", mid)["model"] == "opus")
me = next((m for m in r["members"] if m["id"] == mid), None)
check("connect: roster carries model", me and me.get("model") == "opus")

# connect without a model → empty, not missing
r2 = json.loads(srv.nth_connect(summary="t", name="Plain", channel="modeltest"))
check("connect: no model -> empty string", member_row("modeltest", r2["member_id"])["model"] == "")

# over-long model capped at 40 chars
r3 = json.loads(srv.nth_connect(summary="t", name="Long", channel="modeltest", model="x" * 80))
check("connect: model capped at 40", len(member_row("modeltest", r3["member_id"])["model"]) == 40)

# web _fetch_roster (on EventHub) surfaces the model
hub = web.EventHub(srv.DB_PATH, "modeltest")
db = srv.get_db()
try:
    roster = hub._fetch_roster(db)
finally:
    db.close()
opus = next((m for m in roster if m["id"] == mid), None)
check("web roster: model present", opus and opus.get("model") == "opus")

# web self-migration includes the model column (legacy DB path)
import sqlite3  # noqa: E402
legacy = sqlite3.connect(":memory:")
legacy.execute("CREATE TABLE members (id TEXT, channel TEXT, name TEXT)")
legacy.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, channel TEXT, content TEXT)")
web.ensure_ask_columns(legacy)
cols = {row[1] for row in legacy.execute("PRAGMA table_info(members)")}
check("ensure_ask_columns adds members.model", "model" in cols)
legacy.close()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
