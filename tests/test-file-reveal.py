"""Tests for clickable-file-path endpoints (POST /api/path/validate, /api/reveal).

Real temp files → validate reports existence and reveal builds a SAFE Finder
call; missing paths → exists=false / 404; injection-style values ("; rm -rf ~",
a leading-dash "--flag") never reach a shell and never launch anything. The
actual `open -R` is MOCKED (web.subprocess.run) so the test asserts the exact
arg list without popping a Finder window, exercising the whole validation +
arg-construction path.
Usage: python tests/test-file-reveal.py
"""
import json
import os
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []
skips = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def skip(name, why):
    print(f"SKIP: {name} ({why})")
    skips.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_reveal_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"

# A real file to reveal, and a real directory.
real_file = os.path.join(_tmp, "hello world.txt")
with open(real_file, "w") as f:
    f.write("hi")
missing = os.path.join(_tmp, "does-not-exist.txt")

# Mock the Finder launch: record the exact call, never spawn `open`.
reveal_calls = []


def fake_run(args, **kwargs):
    reveal_calls.append({"args": args, "kwargs": kwargs})
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")


web.subprocess.run = fake_run


def http(port, path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


r = json.loads(srv.nth_connect(summary="t", name="R", channel="revealtest"))
CH = r["channel"]

hub = web.EventHub(srv.DB_PATH, CH)
server = None
try:
    hub.start()
    web.NthWebHandler.hub = hub
    web.NthWebHandler.channel = CH
    web.NthWebHandler.db_path = srv.DB_PATH
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # ── /api/path/validate ──
    st, resp = http(port, "/api/path/validate", {"paths": [real_file, missing, "~"]})
    check("validate: 200", st == 200)
    ex = resp.get("exists", {})
    check("validate: real file exists=true", ex.get(real_file) is True)
    check("validate: missing exists=false", ex.get(missing) is False)
    check("validate: ~ expands and exists=true", ex.get("~") is True)

    # Injection-style tokens are just non-existent strings — never executed.
    inj = ['"; rm -rf ~"', "--flag", "-R", "$(whoami)", "a\x00b"]
    st, resp = http(port, "/api/path/validate", {"paths": inj})
    check("validate: injection tokens all exist=false",
          st == 200 and all(v is False for v in resp.get("exists", {}).values()))

    # Bad input shapes.
    st, _ = http(port, "/api/path/validate", {"paths": "notalist"})
    check("validate: non-list paths -> 400", st == 400)
    st, resp = http(port, "/api/path/validate", {"paths": []})
    check("validate: empty list -> 200 empty map", st == 200 and resp.get("exists") == {})

    # Cap: 205 unique missing paths + the real one; capped at 200, but the real
    # one is first so it's within the cap and still validated true.
    many = [real_file] + [f"/nope/{i}" for i in range(205)]
    st, resp = http(port, "/api/path/validate", {"paths": many})
    ex = resp.get("exists", {})
    check("validate: caps candidates at 200", st == 200 and len(ex) <= 200)
    check("validate: real file still true under cap", ex.get(real_file) is True)

    # ── /api/reveal ──
    reveal_calls.clear()
    st, resp = http(port, "/api/reveal", {"path": real_file})
    check("reveal: real file -> 200 ok", st == 200 and resp.get("ok") is True)
    if reveal_calls:
        call = reveal_calls[-1]
        args = call["args"]
        check("reveal: subprocess called with an ARG LIST (no shell string)",
              isinstance(args, list))
        check("reveal: no shell=True", call["kwargs"].get("shell") in (None, False))
        if sys.platform == "darwin":
            check("reveal: uses `open -R` (reveal, not launch)",
                  args[:2] == ["open", "-R"])
            check("reveal: `--` guards against flag injection", "--" in args)
            check("reveal: reveals the abspath of the real file",
                  args[-1] == os.path.abspath(real_file))
        else:
            skip("reveal: darwin arg assertions", f"platform is {sys.platform}")
    else:
        check("reveal: subprocess.run was invoked", False)

    # path:line[:col] suffix is stripped before revealing.
    reveal_calls.clear()
    st, resp = http(port, "/api/reveal", {"path": real_file + ":42:7"})
    check("reveal: path:line:col accepted -> 200", st == 200)
    if reveal_calls and sys.platform == "darwin":
        check("reveal: :line:col stripped, file revealed",
              reveal_calls[-1]["args"][-1] == os.path.abspath(real_file))

    # Missing path → 404 and NO subprocess call at all.
    reveal_calls.clear()
    st, resp = http(port, "/api/reveal", {"path": missing})
    check("reveal: missing path -> 404", st == 404)
    check("reveal: missing path never invokes open", not reveal_calls)

    # A leading-dash / injection value that doesn't exist → 404, open untouched.
    for bad in ["--flag", "-R", '"; rm -rf ~"', "$(whoami)"]:
        reveal_calls.clear()
        st, _ = http(port, "/api/reveal", {"path": bad})
        check(f"reveal: injection {bad!r} -> 404, no exec",
              st == 404 and not reveal_calls)

    # Empty / missing / non-string path → 400.
    for bad in ({"path": ""}, {"path": "   "}, {"path": 123}, {}):
        st, _ = http(port, "/api/reveal", bad)
        check(f"reveal: bad body {bad} -> 400", st == 400)

except OSError as e:
    skip("file-reveal", f"could not start server: {e}")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s), {len(skips)} skip(s)")
sys.exit(1 if failures else 0)
