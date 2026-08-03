"""Guards on the composed, no-build Phase 7 web bundle. Usage: python tests/test-web-bundle.py."""
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
boot_source = web._read_web_source("js/90-boot.js")
check("served bundle: still a complete page", served.rstrip().endswith("</html>"))
check("served bundle: template placeholders substituted", "__TRIO_" not in served)
check("served bundle: Atrium shell present", 'class="app"' in served and 'id="workspace-rail"' in served)
check("served bundle: file-link CSS restored", "a.file-link" in served and "file-link-err" in served)
check("served bundle: source CSS inlined", 'data-trio-source="css/00-tokens.css"' in served)
check("served bundle: source JS inlined", 'data-trio-source="js/00-core.js"' in served)
check("served bundle: test hook excluded", "__TRIO_TEST__" not in served)
check("module lists are ordered", web.WEB_JS_FILES[0] == "js/01-store.js" and web.WEB_JS_FILES[-2] == "js/90-boot.js")
check("boot mounts the composer feature", "'composer'" in boot_source)
check("deep-link page paths serve the app shell", {"/", "/inbox", "/tasks", "/agents", "/settings"}.issubset(web.UI_PATHS))
try:
    web._read_web_source("../nth_web.py")
except ValueError:
    escaped = True
else:
    escaped = False
check("path guard rejects escape", escaped)
try:
    web._read_web_source("js/not-a-real-module.js")
except RuntimeError as e:
    missing = "required web source missing" in str(e)
else:
    missing = False
check("missing asset fails clearly", missing)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
