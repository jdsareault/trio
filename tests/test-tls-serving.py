"""Tests for HTTPS serving in nth_web (--tailscale-tls / --tls-cert).

Why this exists: browsers expose getUserMedia -- the microphone, and therefore
the whole dictation feature -- only on a SECURE CONTEXT (https, or a literal
localhost origin). A dashboard served as http://100.x.y.z:8765 is neither, so
`navigator.mediaDevices` is undefined there and BOTH dictation engines fail:
the local-Whisper path cannot record, and the browser SpeechRecognition
fallback is refused on an insecure origin too. Serving TLS is the entire fix.

The load-bearing claim is narrower than "TLS works", though. We terminate TLS
in THIS process rather than parking `tailscale serve` in front, because a
front proxy delivers every request from 127.0.0.1 -- which trips
resolve_from_loopback() and mints every visitor, phone included, as the local
OS account. So the test that matters is not just "https responds" but
"`client_address` is still the peer's own address after the socket is
wrapped". If that ever regresses, identity silently collapses to one tier and
nothing else in the suite would notice.

Sections:
  1  argument validation   -- the flag combinations that must fail early
  2  build_ssl_context     -- errors name the file the operator has to fix
  3  tailscale_dns_name    -- MagicDNS parsing, incl. the trailing dot
  4  ensure_tailscale_cert -- failure surfaces the CLI's own reason
  5  end-to-end https      -- real TLS handshake + client_address preserved
                              (skipped when openssl(1) is unavailable)

Usage: python tests/test-tls-serving.py
"""
import json
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []
skipped = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def skip(name, why):
    print(f"SKIP: {name} ({why})")
    skipped.append(name)


_tmp = Path(tempfile.mkdtemp(prefix="nth_tls_"))
srv.DB_DIR = _tmp
srv.DB_PATH = _tmp / "nth.db"


# ───────── 1. argument validation ─────────
# These must fail BEFORE the database, the network, or a port is touched:
# a half-specified TLS pair that only blows up after the hubs are running
# leaves a lease row behind and wakes agents for a server that never came up.
def run_main(argv):
    """Call web.main() with argv, capturing the exit code and stderr."""
    import io
    import contextlib
    err = io.StringIO()
    old = sys.argv
    sys.argv = ["nth_web.py"] + argv
    try:
        with contextlib.redirect_stderr(err):
            code = web.main()
    finally:
        sys.argv = old
    return code, err.getvalue()

code, err = run_main(["--tls-cert", str(_tmp / "c.pem"), "--db", str(srv.DB_PATH)])
check("--tls-cert without --tls-key exits 1", code == 1)
check("--tls-cert without --tls-key says they pair", "together" in err)

code, err = run_main(["--tls-key", str(_tmp / "k.pem"), "--db", str(srv.DB_PATH)])
check("--tls-key without --tls-cert exits 1", code == 1)

code, err = run_main(["--tailscale-tls", "--tls-cert", str(_tmp / "c.pem"),
                      "--tls-key", str(_tmp / "k.pem"), "--db", str(srv.DB_PATH)])
check("--tailscale-tls with an explicit pair exits 1", code == 1)
check("...and explains which flag to drop", "drop" in err)


# ───────── 2. build_ssl_context ─────────
# load_cert_chain's own message for a missing file is a bare ENOENT with no
# filename in it. An operator reading that has no idea WHICH of the two paths
# they mistyped, so the wrapper names it.
missing_cert = _tmp / "nope.crt"
missing_key = _tmp / "nope.key"
try:
    web.build_ssl_context(missing_cert, missing_key)
    check("missing certificate raises", False)
except RuntimeError as exc:
    check("missing certificate raises", True)
    check("missing-certificate error names the path", str(missing_cert) in str(exc))
    check("missing-certificate error says which half", "certificate" in str(exc))

real_cert = _tmp / "self.crt"
real_key = _tmp / "self.key"
openssl = shutil.which("openssl")
if openssl:
    # -addext subjectAltName: a modern client ignores CN entirely, so a cert
    # without a SAN cannot be verified by hostname at all and section 5 would
    # fail for a reason that has nothing to do with the code under test.
    gen = subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(real_key), "-out", str(real_cert), "-days", "1",
         "-subj", "/CN=localhost",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
        capture_output=True,
    )
    if gen.returncode != 0:
        openssl = None

if openssl:
    only_key_missing = _tmp / "absent.key"
    try:
        web.build_ssl_context(real_cert, only_key_missing)
        check("missing key raises even when the cert exists", False)
    except RuntimeError as exc:
        check("missing key raises even when the cert exists", True)
        check("missing-key error names the key, not the cert",
              str(only_key_missing) in str(exc) and "private key" in str(exc))

    # A cert paired with a key that is not its own. OpenSSL's raw message is
    # accurate and unreadable; the wrapper keeps it but names both files.
    other_key = _tmp / "other.key"
    other_cert = _tmp / "other.crt"
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(other_key), "-out", str(other_cert), "-days", "1",
         "-subj", "/CN=other"], capture_output=True, check=True)
    try:
        web.build_ssl_context(real_cert, other_key)
        check("mismatched cert/key pair raises", False)
    except RuntimeError as exc:
        check("mismatched cert/key pair raises", True)
        check("mismatch error names both files",
              str(real_cert) in str(exc) and str(other_key) in str(exc))

    ctx = web.build_ssl_context(real_cert, real_key)
    check("a valid pair yields an SSLContext", isinstance(ctx, ssl.SSLContext))
else:
    skip("build_ssl_context pair checks", "openssl(1) not on PATH")


# ───────── 3. tailscale_dns_name ─────────
# `tailscale status --json` reports Self.DNSName as a FQDN with a trailing
# dot. Leaving it on produces "macbook.tail0abc.ts.net.:8765" in the banner
# and in the cert request -- a name no browser will match.
class _FakeCompleted:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


def with_fake_tailscale(check_output=None, run=None, candidates=("tailscale",)):
    """Swap nth_web's subprocess entry points and CLI candidate list."""
    saved = (web.subprocess.check_output, web.subprocess.run, web.TAILSCALE_CANDIDATES)

    class _Restore:
        def __enter__(self_inner):
            if check_output is not None:
                web.subprocess.check_output = check_output
            if run is not None:
                web.subprocess.run = run
            web.TAILSCALE_CANDIDATES = candidates
            return self_inner

        def __exit__(self_inner, *exc):
            (web.subprocess.check_output, web.subprocess.run,
             web.TAILSCALE_CANDIDATES) = saved
            return False
    return _Restore()


status_json = json.dumps({"Self": {"DNSName": "macbook.tail63b486.ts.net."}}).encode()
with with_fake_tailscale(check_output=lambda *a, **k: status_json):
    check("tailscale_dns_name reads Self.DNSName and strips the trailing dot",
          web.tailscale_dns_name() == "macbook.tail63b486.ts.net")

with with_fake_tailscale(check_output=lambda *a, **k: json.dumps({"Self": {}}).encode()):
    check("tailscale_dns_name returns None when DNSName is absent",
          web.tailscale_dns_name() is None)


def _boom(*a, **k):
    raise FileNotFoundError("tailscale")


with with_fake_tailscale(check_output=_boom):
    check("tailscale_dns_name returns None when the CLI is missing",
          web.tailscale_dns_name() is None)

with with_fake_tailscale(check_output=lambda *a, **k: b"not json at all"):
    check("tailscale_dns_name survives unparseable CLI output",
          web.tailscale_dns_name() is None)


# ───────── 4. ensure_tailscale_cert ─────────
# The overwhelmingly likely failure is "HTTPS Certificates is not enabled for
# this tailnet", which is a switch in the admin console and is invisible from
# here. Relaying the CLI's stderr AND pointing at that page is the difference
# between a five-second fix and an afternoon.
def _cert_fail(*a, **k):
    return _FakeCompleted(stderr=b"HTTPS is not enabled for this tailnet", returncode=1)


with with_fake_tailscale(run=_cert_fail):
    try:
        web.ensure_tailscale_cert("macbook.tail63b486.ts.net", _tmp / "tls")
        check("a failing `tailscale cert` raises", False)
    except RuntimeError as exc:
        check("a failing `tailscale cert` raises", True)
        check("the error relays the CLI's own reason",
              "HTTPS is not enabled" in str(exc))
        check("the error points at the admin DNS page",
              "admin/dns" in str(exc))


def _cert_ok(cmd, **k):
    # Mimic the CLI: write both files where the caller asked.
    Path(cmd[cmd.index("--cert-file") + 1]).write_text("cert")
    Path(cmd[cmd.index("--key-file") + 1]).write_text("key")
    return _FakeCompleted(returncode=0)


with with_fake_tailscale(run=_cert_ok):
    cert_dir = _tmp / "tlsdir"
    got_cert, got_key = web.ensure_tailscale_cert("macbook.tail63b486.ts.net", cert_dir)
    check("ensure_tailscale_cert creates its directory", cert_dir.is_dir())
    check("ensure_tailscale_cert returns the written pair",
          got_cert.exists() and got_key.exists())
    # The key is a credential sitting in a shared home directory; the CLI's
    # umask is not something to inherit silently.
    check("the private key is not group/world readable",
          (got_key.stat().st_mode & 0o077) == 0)


# ───────── 5. end-to-end https ─────────
# The point of this section: after wrap_socket, `client_address` must still be
# the peer's own address. That is the property that keeps tailscale_whois()
# able to name the operator, and it is the entire reason TLS terminates in
# this process instead of behind `tailscale serve`.
if not openssl:
    skip("end-to-end https", "openssl(1) not on PATH")
else:
    r = json.loads(srv.nth_connect(summary="t", name="R", channel="tlstest"))
    CH = r["channel"]
    hub = web.EventHub(srv.DB_PATH, CH)
    server = None
    seen_peers = []
    try:
        hub.start()
        web.NthWebHandler.hub = hub
        web.NthWebHandler.channel = CH
        web.NthWebHandler.db_path = srv.DB_PATH

        server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
        port = server.server_address[1]
        # Exactly what main() does — wrap the LISTENING socket, so every
        # accepted connection is TLS.
        server.socket = web.build_ssl_context(real_cert, real_key).wrap_socket(
            server.socket, server_side=True)
        server.daemon_threads = True

        original_client_ip = web.NthWebHandler._client_ip

        def _recording_client_ip(self):
            value = original_client_ip(self)
            seen_peers.append(value)
            return value

        web.NthWebHandler._client_ip = _recording_client_ip

        threading.Thread(target=server.serve_forever, daemon=True).start()
        time.sleep(0.2)

        verify = ssl.create_default_context(cafile=str(real_cert))
        req = urllib.request.Request(f"https://localhost:{port}/")
        try:
            with urllib.request.urlopen(req, timeout=10, context=verify) as resp:
                status, body = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()

        check("https GET completes a verified TLS handshake", status == 200)
        check("https GET returns the dashboard HTML", b"<html" in body.lower())

        # Plain http against the TLS port must not be answered as if it were
        # fine -- and must not spew a traceback per attempt either (see
        # QuietThreadingHTTPServer.handle_error).
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5)
            check("plain http to the TLS port fails", False)
        except Exception:
            check("plain http to the TLS port fails", True)

        # A failed handshake must not take the listener down with it -- a
        # stale http:// bookmark should cost one error, not the dashboard.
        try:
            with urllib.request.urlopen(f"https://localhost:{port}/", timeout=10,
                                        context=verify) as resp:
                again = resp.status
        except urllib.error.HTTPError as e:
            again = e.code
        check("the server still serves after a bad handshake", again == 200)

        # THE claim: TLS termination here did not rewrite the peer address.
        check("client_address survives socket wrapping (identity intact)",
              bool(seen_peers) and all(p == "127.0.0.1" for p in seen_peers))
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        hub.stop()

print()
if skipped:
    print(f"{len(skipped)} skipped: " + ", ".join(skipped))
if failures:
    print(f"{len(failures)} FAILED: " + ", ".join(failures))
    sys.exit(1)
print("all TLS serving checks passed")
