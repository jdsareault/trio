"""Tests for /api/attachment/<id> visibility gating — the web-perimeter
follow-up to real private DMs.

Attachment bytes are message content. Before this fix, GET /api/attachment/<id>
served the bytes with NO identity check, so any reachable client could fetch a
DM image attachment by id and bypass the can_see() visibility engine. The
endpoint now resolves the requester (like the SSE feed / search) and applies the
SAME predicate to the attachment's OWNING message.

Covers:
  (op)      the all-seeing operator fetches a DM attachment            -> 200
  (recip)   the DM's recipient fetches it                              -> 200
  (sender)  the DM's sender fetches their own attachment               -> 200
  (deny)    a non-recipient guest/agent fetches it                     -> 404 (not 403)
  (bcast)   a broadcast attachment still fetches for any identified viewer -> 200
  (pending) a pending/unidentified requester gets nothing              -> 403
  (missing) an unknown id                                              -> 404 (same as deny: no oracle)

Usage: python tests/test-attachment-visibility.py
"""
import json
import tempfile
import threading
import time
import urllib.error
import urllib.request
import shutil
import re
import sqlite3
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv          # noqa: E402
import nth_web as web            # noqa: E402
from nth_web import OperatorIdentity, OPERATOR_REGISTRY  # noqa: E402
from nth_web import (IDENTITY_SOURCE_LOOPBACK, IDENTITY_SOURCE_GUEST,  # noqa: E402
                     IDENTITY_SOURCE_PENDING)
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_att_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"
# Attachments live under a per-channel dir; point it at the temp tree so the
# handler's path-safety confinement passes for our fixture files.
web.ATTACH_DIR = Path(_tmp) / "attachments"

PNG_1x1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082"
)

# ── Roster: Alice (sender), Bob (recipient), Carol (non-recipient) ──
A = json.loads(srv.nth_connect(summary="a", name="Alice", channel="attest"))
CH = A["channel"]
alice = A["member_id"]
bob = json.loads(srv.nth_connect(summary="b", name="Bob", channel=CH))["member_id"]
carol = json.loads(srv.nth_connect(summary="c", name="Carol", channel=CH))["member_id"]


def write_attachment(channel, message_id, member_id, data=PNG_1x1):
    """Create a real file under the channel's attachment dir + an attachments
    row linked to `message_id`, returning the new attachment id. Mirrors what
    /api/upload + /api/send would persist."""
    chan_dir = web.ATTACH_DIR / re.sub(r"[^\w.\-]", "_", channel)
    chan_dir.mkdir(parents=True, exist_ok=True)
    f = chan_dir / f"att_{message_id}_{member_id}.png"
    f.write_bytes(data)
    db = srv.get_db()
    try:
        web.ensure_attachments_table(db)
        cur = db.execute(
            "INSERT INTO attachments (channel, message_id, member_id, mime, "
            "filename, width, height, bytes, path, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (channel, message_id, member_id, "image/png", "x.png",
             1, 1, len(data), str(f), srv.now_iso()),
        )
        db.commit()
        return cur.lastrowid
    finally:
        db.close()


# ── Alice DMs Bob (recipients=[bob]) with an attachment ──
dm = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="secret pic", to="Bob"))
DM_ID = dm["message_id"]
DM_ATT = write_attachment(AGENT_INBOX_CHANNEL, DM_ID, alice)

# ── Alice broadcasts with an attachment (recipients empty = everyone) ──
bc = json.loads(srv.nth_send(channel=CH, member_id=alice, message="team photo"))
BC_ID = bc["message_id"]
BC_ATT = write_attachment(CH, BC_ID, alice)

# ── Register cookie-bound identities the handler will resolve. Registering the
#    token wins over loopback/tailscale resolution (OPERATOR_REGISTRY.get is
#    checked first in _resolve_identity), so we can drive each viewer precisely.
OP_TOK = "tok-operator"
BOB_TOK = "tok-bob-recip"
CAROL_TOK = "tok-carol-nonrecip"
ALICE_TOK = "tok-alice-sender"
PEND_TOK = "tok-pending"
OPERATOR_REGISTRY.put(OP_TOK, OperatorIdentity(
    member_id="_op_l_host_gabe", name="Operator", source=IDENTITY_SOURCE_LOOPBACK))
OPERATOR_REGISTRY.put(BOB_TOK, OperatorIdentity(
    member_id=bob, name="Bob", source=IDENTITY_SOURCE_GUEST))
OPERATOR_REGISTRY.put(CAROL_TOK, OperatorIdentity(
    member_id=carol, name="Carol", source=IDENTITY_SOURCE_GUEST))
OPERATOR_REGISTRY.put(ALICE_TOK, OperatorIdentity(
    member_id=alice, name="Alice", source=IDENTITY_SOURCE_GUEST))
OPERATOR_REGISTRY.put(PEND_TOK, OperatorIdentity(
    member_id="_op_p_unknown", name="", source=IDENTITY_SOURCE_PENDING))


def fetch(att_id, token=None, channel=CH):
    """GET /api/attachment/<att_id> with an optional identity cookie.
    Returns (status, body_bytes)."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/attachment/{att_id}?channel={channel}", method="GET")
    if token:
        req.add_header("Cookie", f"{web.OP_COOKIE}={token}")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# LOTC/Sauron + LOTC/Aragorn: channel_attach_dir is the single sanitizer both
# the upload/serve paths (above/below) and the per-agent --add-dir grant
# (nth_supervisor.build_spawn_argv) route through — verify it directly.
import nth_constants as nc  # noqa: E402
_probe_root = Path(tempfile.mkdtemp(prefix="nth-attach-dir-probe-"))
check("channel_attach_dir: normal channel code resolves under base",
      nc.channel_attach_dir("attest", base=_probe_root) == _probe_root / "attest")
check("channel_attach_dir: '..' cannot escape the root (hardened regex strips dots)",
      nc.channel_attach_dir("..", base=_probe_root) == _probe_root / "__")
check("channel_attach_dir: '../../etc' collapses to a literal in-root name, not a traversal",
      nc.channel_attach_dir("../../etc", base=_probe_root).resolve().parent == _probe_root.resolve())
check("channel_attach_dir: defaults to nth_constants.ATTACH_DIR when base omitted",
      nc.channel_attach_dir("attest") == nc.ATTACH_DIR / "attest")
shutil.rmtree(_probe_root, ignore_errors=True)

hub = web.EventHub(srv.DB_PATH, CH)
server = None
try:
    hub.start()
    web.NthWebHandler.hub = hub
    # Exercise the guest/member visibility path in the supported
    # single-channel mode. `channel` is now a per-request property; the CLI
    # channel is carried by `_default_channel`.
    web.NthWebHandler._default_channel = CH
    web.NthWebHandler.db_path = srv.DB_PATH
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    PORT = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # (op) all-seeing operator fetches the DM attachment -> 200 + real bytes
    st, body = fetch(DM_ATT, OP_TOK, AGENT_INBOX_CHANNEL)
    check("(op) operator fetches DM attachment -> 200", st == 200)
    check("(op) operator gets the real bytes", body == PNG_1x1)

    # (recip) the DM's recipient (Bob) fetches it -> 200
    st, body = fetch(DM_ATT, BOB_TOK, AGENT_INBOX_CHANNEL)
    check("(recip) DM recipient fetches DM attachment -> 200", st == 200)
    check("(recip) recipient gets the real bytes", body == PNG_1x1)

    # (sender) the DM's sender (Alice) fetches their own attachment -> 200
    st, _ = fetch(DM_ATT, ALICE_TOK, AGENT_INBOX_CHANNEL)
    check("(sender) DM sender fetches own DM attachment -> 200", st == 200)

    # (deny) a NON-recipient (Carol) fetches the DM attachment -> 404, NOT 403,
    #        and no bytes. 404 keeps the id from being an existence oracle.
    st, body = fetch(DM_ATT, CAROL_TOK, AGENT_INBOX_CHANNEL)
    check("(deny) non-recipient guest DENIED DM attachment -> 404", st == 404)
    check("(deny) non-recipient gets NO bytes", body != PNG_1x1)
    check("(deny) denial is 404 not 403 (no existence oracle)", st != 403)

    # (bcast) a broadcast attachment still fetches for any IDENTIFIED viewer —
    #         the non-recipient Carol gets it (no regression to image sharing).
    st, body = fetch(BC_ATT, CAROL_TOK)
    check("(bcast) non-recipient fetches BROADCAST attachment -> 200", st == 200)
    check("(bcast) broadcast bytes served intact", body == PNG_1x1)
    # ...and the operator + recipient obviously get it too.
    check("(bcast) operator fetches broadcast attachment -> 200",
          fetch(BC_ATT, OP_TOK)[0] == 200)

    # (pending) a pending / unidentified requester gets nothing — even for a
    #           broadcast — matching the sibling gated endpoints.
    check("(pending) pending requester DENIED DM attachment -> 403",
          fetch(DM_ATT, PEND_TOK, AGENT_INBOX_CHANNEL)[0] == 403)
    check("(pending) pending requester DENIED broadcast attachment -> 403",
          fetch(BC_ATT, PEND_TOK)[0] == 403)

    # (missing) an unknown id is a 404 for an identified viewer — the SAME
    #           response a non-recipient gets for a real DM id, so existence
    #           can't be probed.
    st, _ = fetch(999999, CAROL_TOK)
    check("(missing) unknown id -> 404 (indistinguishable from deny)", st == 404)

    # (non-digit) a non-numeric tail -> 404 (no path from user input)
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/attachment/..%2f..%2fetc%2fpasswd", method="GET")
    req.add_header("Cookie", f"{web.OP_COOKIE}={OP_TOK}")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            trav_st = resp.status
    except urllib.error.HTTPError as e:
        trav_st = e.code
    check("(traversal) non-numeric id rejected -> 404", trav_st == 404)

except OSError as e:
    check("attachment test: server started", False)
    print(f"  (server error: {e})")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
