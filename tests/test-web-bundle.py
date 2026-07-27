"""Guards on the served web bundle (INDEX_HTML).

The client __TRIO_TEST__ hook exposes internal state (operator identity, session
data, member map) and exists ONLY for the Node DOM harness. It must never ship
to a browser: nth_web.py strips the marker-delimited block at render time. This
test locks that in — and also verifies the RAW source still carries the block,
so tests/dom-harness.py (which reads the raw file) keeps working.
Usage: python tests/test-web-bundle.py
"""
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_web as web    # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


served = web.INDEX_HTML
raw = (SERVER / "nth_web.py").read_text()

# The served bundle must not contain the hook, its markers, or the global it
# assigns — the internal `state` reference must never reach a browser.
check("served bundle: hook global stripped", "__TRIO_TEST__" not in served)
check("served bundle: hook markers stripped", "TRIO_TEST_HOOK" not in served)
check("served bundle: still a complete page", served.rstrip().endswith("</html>"))
check("served bundle: client script intact (boot present)", "boot();" in served)
check("served bundle: placeholders all substituted", "/*__" not in served)

# The raw source keeps the block (with both sentinel markers) so the DOM
# harness, which reads this file directly, still sees the hook.
check("raw source: START marker present", "__TRIO_TEST_HOOK_START__" in raw)
check("raw source: END marker present", "__TRIO_TEST_HOOK_END__" in raw)
check("raw source: hook assignment present", "globalThis.__TRIO_TEST__ = {" in raw)

# The strip helper is idempotent / safe on already-clean input.
check("strip is a no-op on clean input", web._strip_test_hook(served) == served)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
