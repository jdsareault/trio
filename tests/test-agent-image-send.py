"""Tests for agent-side image attachments — the `images` param on trio_send /
trio_dm that lets an agent post screenshots into a channel.

Covers:
  • _validate_agent_images: good images parsed; non-image (magic-byte gate),
    missing path, empty file, oversized, and too-many all rejected as ValueError
  • nth_send with images: attachment rows created + linked to the message,
    files written under the sanitized channel attach dir, chmod 0644, and the
    response carries an `attachments` list
  • image-only send (blank message) is allowed and stored as "[image]"
  • a bad image path makes nth_send fail cleanly (error JSON) and creates NO
    message row and NO orphan file (atomic rollback)
  • nth_dm with images: same linkage, private-scoped
  • nth_poll delivers linked images to another agent as MCP Image blocks
  • _persist_agent_images unlinks already-written files if a later write fails
Usage: python tests/test-agent-image-send.py
"""
import base64
import json
import os
import sqlite3
import tempfile
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402  (banner prints on import — harmless)

failures = []
skips = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = Path(tempfile.mkdtemp(prefix="nth_img_"))
srv.DB_DIR = _tmp
srv.DB_PATH = _tmp / "nth.db"
srv.ATTACH_DIR = _tmp / "attach"          # isolate disk writes

# A real 1x1 PNG and a couple of on-disk fixtures.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
shot1 = _tmp / "shot one.png"; shot1.write_bytes(PNG)
shot2 = _tmp / "shot2.png"; shot2.write_bytes(PNG)
notimg = _tmp / "hax.png"; notimg.write_bytes(b"#!/bin/sh\nrm -rf /\n")
empty = _tmp / "empty.png"; empty.write_bytes(b"")
# Minimal magic-byte-only fixtures for the other three accepted formats — the
# sniffer keys off the signature, it does not decode the image.
jpg = _tmp / "p.jpg"; jpg.write_bytes(b"\xff\xd8\xff" + b"\x00" * 32)
gif = _tmp / "p.gif"; gif.write_bytes(b"GIF89a" + b"\x00" * 32)
webp = _tmp / "p.webp"; webp.write_bytes(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 16)
# A name full of characters the web upload path strips — used to prove parity.
weird = _tmp / "a<b>&'.png"; weird.write_bytes(PNG)


def rows_for(mid):
    db = srv.get_db()
    try:
        srv.ensure_attachments_table(db)
        return db.execute(
            "SELECT id, channel, message_id, member_id, mime, filename, bytes, path "
            "FROM attachments WHERE message_id=? ORDER BY id", (mid,)).fetchall()
    finally:
        db.close()


def msg_count(ch):
    db = srv.get_db()
    try:
        return db.execute("SELECT COUNT(*) FROM messages WHERE channel=?", (ch,)).fetchone()[0]
    finally:
        db.close()


# ── unit: _validate_agent_images ─────────────────────────────────────
v = srv._validate_agent_images(f"{shot1}, {shot2}")
check("validate: two images parsed", len(v) == 2 and v[0]["mime"] == "image/png")
check("validate: original filename kept", v[0]["filename"] == "shot one.png")
check("validate: empty arg -> []", srv._validate_agent_images("") == []
      and srv._validate_agent_images("  ,  ") == [])


def rejects(arg, label):
    try:
        srv._validate_agent_images(arg)
        check(label, False)
    except ValueError:
        check(label, True)


rejects(str(notimg), "validate: non-image rejected (magic-byte gate)")
rejects("/no/such/file.png", "validate: missing path rejected")
rejects(str(empty), "validate: empty file rejected")
rejects(",".join([str(shot1)] * (srv.MAX_ATTACH_COUNT + 1)), "validate: too many rejected")

# ── all four formats accepted (not just PNG) ─────────────────────────
fmts = srv._validate_agent_images(f"{jpg},{gif},{webp}")
check("validate: jpeg/gif/webp all accepted",
      [f["mime"] for f in fmts] == ["image/jpeg", "image/gif", "image/webp"])

# ── exact count-cap boundary succeeds (only cap+1 rejected above) ─────
at_cap = srv._validate_agent_images(",".join([str(shot1)] * srv.MAX_ATTACH_COUNT))
check("validate: exactly MAX_ATTACH_COUNT accepted", len(at_cap) == srv.MAX_ATTACH_COUNT)

# ── oversized file rejected (size cap) ───────────────────────────────
_orig_cap = srv.MAX_ATTACH_BYTES
srv.MAX_ATTACH_BYTES = 8            # temporarily tiny so the PNG (~70B) is over
try:
    rejects(str(shot1), "validate: oversized file rejected (size cap)")
finally:
    srv.MAX_ATTACH_BYTES = _orig_cap

# ── non-regular file (FIFO) rejected before any blocking read ────────
if hasattr(os, "mkfifo"):
    fifo = _tmp / "pipe.png"
    os.mkfifo(fifo)
    rejects(str(fifo), "validate: FIFO/non-regular file rejected")
    fifo.unlink()
else:
    skips.append("FIFO test (no os.mkfifo)")

# ── filename sanitized like the web upload path ──────────────────────
san_name = srv._validate_agent_images(str(weird))[0]["filename"]
check("validate: filename strips <>&' etc.",
      not any(c in san_name for c in "<>&'") and san_name.startswith("a") and san_name.endswith(".png"))

# ── nth_send with images end-to-end ──────────────────────────────────
r = json.loads(srv.nth_connect(summary="t", name="Ann", channel="imgtest"))
CH, ann = r["channel"], r["member_id"]

res = json.loads(srv.nth_send(channel=CH, member_id=ann,
                              message="verified ✓", images=f"{shot1},{shot2}"))
mid = res.get("message_id")
check("send: ok with attachments in response", res.get("ok") and len(res.get("attachments", [])) == 2)
rows = rows_for(mid)
check("send: two attachment rows linked to message", len(rows) == 2)
if len(rows) == 2:
    for row in rows:
        fp = Path(row["path"])
        check(f"send: file written on disk ({fp.name})", fp.exists() and fp.read_bytes() == PNG)
        check("send: stored under sanitized channel dir", fp.parent.name == CH)
        check("send: bytes column populated", row["bytes"] == len(PNG))
        check("send: member_id is the sender", row["member_id"] == ann)
        check("send: file mode is 0644", oct(fp.stat().st_mode)[-3:] == "644")

# ── image-only send (blank message) ──────────────────────────────────
res2 = json.loads(srv.nth_send(channel=CH, member_id=ann, message="", images=str(shot1)))
mid2 = res2["message_id"]
db = srv.get_db()
content2 = db.execute("SELECT content FROM messages WHERE id=?", (mid2,)).fetchone()[0]
db.close()
check("send: image-only stored as '[image]'", content2 == "[image]")

# ── truly empty (no text, no image) still rejected ───────────────────
res_empty = json.loads(srv.nth_send(channel=CH, member_id=ann, message=""))
check("send: empty text + no images rejected", "error" in res_empty)

# ── bad image path -> clean error, NO message row, NO orphan file ────
before = msg_count(CH)
attach_before = list((srv.ATTACH_DIR / CH).glob("*")) if (srv.ATTACH_DIR / CH).exists() else []
res_bad = json.loads(srv.nth_send(channel=CH, member_id=ann,
                                  message="should fail", images="/no/such.png"))
after = msg_count(CH)
attach_after = list((srv.ATTACH_DIR / CH).glob("*")) if (srv.ATTACH_DIR / CH).exists() else []
check("send: bad image path returns error", "error" in res_bad)
check("send: bad image created no message row", after == before)
check("send: bad image created no orphan file", len(attach_after) == len(attach_before))

# ── mixed batch (good FIRST, bad second) → all-or-nothing rejection ───
# The good image is validated before the bad one, so this proves a valid
# entry never reaches disk when a LATER entry in the same call is invalid.
before_mix = msg_count(CH)
attach_before_mix = list((srv.ATTACH_DIR / CH).glob("*")) if (srv.ATTACH_DIR / CH).exists() else []
res_mix = json.loads(srv.nth_send(channel=CH, member_id=ann,
                                  message="half bad", images=f"{shot1},/no/such.png"))
attach_after_mix = list((srv.ATTACH_DIR / CH).glob("*")) if (srv.ATTACH_DIR / CH).exists() else []
check("send: mixed good+bad batch rejected", "error" in res_mix)
check("send: mixed batch created no message row", msg_count(CH) == before_mix)
check("send: mixed batch wrote no file (good entry not persisted)",
      len(attach_after_mix) == len(attach_before_mix))

# ── nth_dm with images (private) ─────────────────────────────────────
rb = json.loads(srv.nth_connect(summary="t", name="Bob", channel="imgtest"))
bob = rb["member_id"]
resd = json.loads(srv.nth_dm(member_id=ann, to="Bob", message="see this", images=str(shot1)))
check("dm: ok + private + attachments", resd.get("ok") and resd.get("private")
      and len(resd.get("attachments", [])) == 1)
dmid = resd["message_id"]
dm_rows = rows_for(dmid)
check("dm: attachment linked to dm message", len(dm_rows) == 1)
if dm_rows:
    dm_fp = Path(dm_rows[0]["path"])
    check("dm: file written on disk with correct bytes", dm_fp.exists() and dm_fp.read_bytes() == PNG)

# ── reply_to a DM + attach an image in the same call (auto-scope path) ─
resr = json.loads(srv.nth_dm(member_id=bob, to="Ann", message="reply w/ shot",
                             reply_to=dmid, images=str(shot2)))
check("dm-reply: image attached on a reply_to DM",
      resr.get("ok") and len(resr.get("attachments", [])) == 1
      and len(rows_for(resr["message_id"])) == 1)

# ── nth_poll delivers images to another agent as MCP Image blocks ────
# Bob joined after Ann's earlier sends (his watermark skips them), so post a
# fresh broadcast image to the channel now, then poll as Bob.
srv.nth_send(channel=CH, member_id=ann, message="fresh shot", images=str(shot2))
poll = srv.nth_poll(channel=CH, member_id=bob, wait_seconds=0)
img_blocks = [b for b in poll if isinstance(b, srv.Image)] if isinstance(poll, list) else []
check("poll: returns at least one MCP Image block", len(img_blocks) >= 1)

# ── _persist_agent_images: caller-owned cleanup covers a post-write failure ─
# The 2nd file is WRITTEN to disk and THEN the op fails (simulating a chmod or
# later error). The new contract appends each path to the caller's `written`
# list BEFORE writing, so even this on-disk-but-failed file is tracked and the
# caller can unlink it — no orphan survives (Sauron/Uruk-Hai finding).
orig_write = Path.write_bytes
seq = {"n": 0}


def flaky(self, data):
    seq["n"] += 1
    orig_write(self, data)                 # file lands on disk...
    if seq["n"] == 2:
        raise OSError("disk full (simulated)")   # ...then the op fails


Path.write_bytes = flaky
db2 = sqlite3.connect(":memory:"); db2.row_factory = sqlite3.Row
written2 = []
raised = False
try:
    srv._persist_agent_images(db2, "rollch", "ag_x", 99,
                              srv._validate_agent_images(f"{shot1},{shot2}"),
                              srv.now_iso(), written2)
except OSError:
    raised = True
Path.write_bytes = orig_write
check("persist: raises on write failure", raised)
# Both files (incl. the one on disk when the failure hit) are tracked for cleanup.
check("persist: tracks in-progress file before writing", len(written2) == 2)
roll_dir = srv.channel_attach_dir("rollch", base=srv.ATTACH_DIR)
check("persist: failed file is on disk until the caller cleans it",
      any(p.exists() for p in written2))
srv._unlink_agent_images(written2)              # exactly what nth_send/nth_dm do on failure
leftovers = list(roll_dir.glob("*")) if roll_dir.exists() else []
check("persist: no orphan files after caller cleanup", leftovers == [])

print()
if skips:
    print(f"SKIPPED: {skips}")
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("ALL PASSED")
