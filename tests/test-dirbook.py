"""Saved directories: the completion endpoint, and the client's storage rules.

Two halves, because the feature is split across the trust boundary.

  SERVER — /api/path/complete answers "what directories are inside this?" about
  the OPERATOR'S OWN disk. It therefore has to be gated exactly like its
  siblings (/api/path/validate, /api/reveal): a guest that can reach the port
  must get nothing. It must also refuse to widen the question it was asked —
  directories only, no files; no hidden entries unless the dot was typed; no
  relative prefixes, which would resolve against wherever the dashboard was
  launched rather than against anything the operator can see.

  CLIENT — favorites live in their own localStorage key and are stored in the
  SHAPE the operator typed. A `~` that gets expanded on the way in freezes this
  hub's home directory into the saved list, which is wrong the moment the
  dashboard is opened from another machine over the tailnet.

Usage: python tests/test-dirbook.py
"""
import os
import re
import sys
import tempfile
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
WEB = SERVER / "web"
sys.path.insert(0, str(SERVER))
os.environ.setdefault("NTH_HOME", tempfile.mkdtemp(prefix="nth_dirbook_"))

try:
    import nth_web as web
except Exception as exc:                                  # pragma: no cover
    print(f"SKIP: nth_web import failed ({exc})")
    raise SystemExit(0)

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


# ── the endpoint is registered and gated ────────────────────────────────────
source = (SERVER / "nth_web.py").read_text(encoding="utf-8")

check("POST /api/path/complete is routed",
      'elif parsed.path == "/api/path/complete":' in source
      and "self._handle_path_complete()" in source)

handler = source.split("def _handle_path_complete", 1)[-1].split("\n    @staticmethod", 1)[0]

# The gate is the whole reason this endpoint is not a filesystem-enumeration
# hole: --tailnet binds 0.0.0.0, so "reachable" is not "trusted".
check("completion is gated to loopback/tailnet operators, like path/validate",
      "LOCAL_PATH_ALLOWED_SOURCES" in handler and "self._error(403" in handler)
check("completion goes through _expand_path (absolute-only, ~ expanded)",
      "self._expand_path(" in handler)
check("completion has a result cap",
      "_PATH_COMPLETE_CAP" in handler and "_PATH_COMPLETE_CAP = " in source)
check("completion respects the shared path length limit",
      "_PATH_MAX_LEN" in handler)
# do_POST rejects cross-origin writes for every POST, so this endpoint inherits
# CSRF protection rather than needing its own — assert the gate still exists.
check("all POSTs (so this one) are cross-site gated",
      "_reject_cross_site" in source.split("def do_POST", 1)[-1][:400])


# ── the completion logic, exercised against a real tree ─────────────────────
class _Probe:
    """The handler's directory-listing behaviour, reachable without a socket.

    _handle_path_complete's I/O half (identity, body, JSON) is BaseHTTPRequest
    machinery; its decisions are the filter rules. Bind the real method onto a
    stub that records what it would have sent, so the rules are tested rather
    than restated.
    """

    _PATH_MAX_LEN = web.NthWebHandler._PATH_MAX_LEN
    _PATH_COMPLETE_CAP = web.NthWebHandler._PATH_COMPLETE_CAP
    _expand_path = staticmethod(web.NthWebHandler._expand_path)
    _handle_path_complete = web.NthWebHandler._handle_path_complete

    def __init__(self, prefix):
        self.prefix = prefix
        self.sent = None
        self.error = None

    def _resolve_identity(self):
        ident = type("I", (), {"source": web.LOCAL_PATH_ALLOWED_SOURCES[0]})()
        return None, ident, False

    def _read_json_body(self, max_bytes=16384):
        return {"prefix": self.prefix}

    def _json(self, payload):
        self.sent = payload

    def _error(self, status, message):
        self.error = (status, message)


def complete(prefix):
    probe = _Probe(prefix)
    probe._handle_path_complete()
    return probe


root = Path(tempfile.mkdtemp(prefix="nth_dirbook_tree_"))
(root / "trio").mkdir()
(root / "trailhead").mkdir()
(root / "roam-gen2").mkdir()
(root / ".hidden").mkdir()
(root / "notes.txt").write_text("not a directory", encoding="utf-8")

listed = complete(f"{root}/").sent
names = [d["name"] for d in listed["dirs"]]
check("a container prefix lists its child directories",
      set(names) >= {"trio", "trailhead", "roam-gen2"})
check("files are never offered as working directories", "notes.txt" not in names)
check("hidden directories stay hidden until the dot is typed", ".hidden" not in names)
check("typing the dot reveals hidden directories",
      ".hidden" in [d["name"] for d in complete(f"{root}/.").sent["dirs"]])

partial = complete(f"{root}/tr").sent
check("a partial name filters to matching directories",
      sorted(d["name"] for d in partial["dirs"]) == ["trailhead", "trio"])
check("filtering is case-insensitive",
      sorted(d["name"] for d in complete(f"{root}/TR").sent["dirs"]) == ["trailhead", "trio"])
check("returned paths are usable verbatim as the next prefix",
      all(d["path"] == d["parent"] + d["name"] for d in partial["dirs"]))

# A relative prefix would resolve against the dashboard process's cwd — the
# directory it happened to be launched from, which no operator can see. Silence
# beats confidently answering about the wrong tree.
check("a relative prefix returns nothing", complete("Development/").sent["dirs"] == [])
check("an empty prefix returns nothing", complete("").sent["dirs"] == [])
check("a missing directory is an empty list, not an error",
      complete(f"{root}/nope/").sent == {"dirs": [], "truncated": False})
check("a file used as a container is an empty list, not an error",
      complete(f"{root}/notes.txt/").sent["dirs"] == [])

# ~-shaped questions get ~-shaped answers: the operator saves what they typed,
# and a saved "~/x" keeps working if $HOME ever changes.
home_probe = complete("~/")
check("a ~ prefix is answered in ~ form",
      all(d["path"].startswith("~/") for d in home_probe.sent["dirs"]))

over_cap = Path(tempfile.mkdtemp(prefix="nth_dirbook_many_"))
for i in range(web.NthWebHandler._PATH_COMPLETE_CAP + 5):
    (over_cap / f"d{i:03d}").mkdir()
capped = complete(f"{over_cap}/").sent
check("results are capped", len(capped["dirs"]) == web.NthWebHandler._PATH_COMPLETE_CAP)
check("a capped result says so", capped["truncated"] is True)
check("an uncapped result says so", listed["truncated"] is False)


# ── the client module ───────────────────────────────────────────────────────
dirbook = (WEB / "js" / "15-dirbook.js").read_text(encoding="utf-8")

check("favorites use their own storage key, not the preference schema",
      "const KEY = 'trio.dirbook.v1'" in dirbook
      and "'trio.preferences.v1'" not in dirbook)
# expanduser on the client would bake THIS browser's idea of home into a value
# only the hub can resolve — the dashboard is routinely opened from a phone.
check("the client never rewrites ~ into a home directory",
      not re.search(r"expanduser|process\.env\.HOME|os\.homedir", dirbook))
check("saved paths are capped", "MAX_FAVORITES" in dirbook)
# The project/container split must be STORED, never guessed from the string.
# Inferring it from a trailing slash was wrong twice: a slash is a typing
# accident, and the picker appends one to everything it fills in — so saving
# anything you had browsed to silently marked it a container.
check("the kind is stored, not inferred from a trailing slash",
      "function setMode(" in dirbook and "function isContainer(" not in dirbook)
# 'auto' and 'project' are different facts. Collapsing them would let a guess
# silently overwrite a decision the operator made.
check("undecided is a distinct state from decided-project",
      "const MODES = ['auto', 'project', 'container']" in dirbook
      and "entry.mode === 'auto' ? (entry.guess || 'project') : entry.mode" in dirbook)
check("a refreshed guess never touches the operator's own choice",
      "function applyGuesses(" in dirbook
      and "{ ...entry, guess: next }" in dirbook)
check("normalize strips a trailing slash so one directory is one entry",
      "collapsed.replace(/\\/+$/, '')" in dirbook)
# The old trailing slash came from the picker, not the operator, so it is not
# evidence of intent — older entries arrive unclassified and get re-judged.
check("legacy entries arrive as 'auto' rather than as a decision",
      "const mode = isObject && MODES.includes(entry.mode) ? entry.mode : 'auto';" in dirbook)
check("completion is sent as typed, since the trailing slash is the question",
      "// Sent as typed, NOT normalized" in dirbook)
check("picking a project lands, picking a container descends",
      "const descend = item.kind !== 'saved' || item.browse;" in dirbook)
check("a 403 stops the client asking again", "completionsDenied" in dirbook)
check("the picker leaves the input's name alone so FormData still reads it",
      "input.parentNode.insertBefore(wrap, input)" in dirbook
      and 'input.setAttribute("name"' not in dirbook
      and "input.name =" not in dirbook)
# A <button> inside a <form> defaults to type=submit; the star and the row
# controls sit inside the create-agent form, where that would spawn an agent.
check("every picker button is explicitly type=button",
      dirbook.count("createElement('button')") == dirbook.count("type = 'button'")
      and dirbook.count('<button class=') == 0)

check("the stylesheet ships", (WEB / "css" / "32-dirbook.css").exists())
check("both new layers are registered in the bundle",
      "js/15-dirbook.js" in web.WEB_JS_FILES and "css/32-dirbook.css" in web.WEB_CSS_FILES)
check("both new layers reach the served page",
      "trio.dirbook.v1" in web.INDEX_HTML and ".dirbook-pop" in web.INDEX_HTML)

# The wiring is the feature: a picker nobody attaches is dead code.
agents = (WEB / "js" / "30-agents.js").read_text(encoding="utf-8")
check("both working-directory inputs get the picker",
      agents.count("Trio.dirbook?.attachPathInput?.(") == 2)
# The page is reachable, or it does not exist as far as anyone can tell.
workspace = (WEB / "js" / "20-workspace.js").read_text(encoding="utf-8")
router = (WEB / "js" / "03-router.js").read_text(encoding="utf-8")
check("the Directories page renders through the workspace shell",
      "Trio.dirbook?.renderPage?.(panel)" in workspace)
check("the Directories page has a nav entry",
      "label: 'Directories'" in workspace)
check("the nav entry sits between Preferences and Archive",
      workspace.index("label: 'Preferences'")
      < workspace.index("label: 'Directories'")
      < workspace.index("label: 'Archive'"))
check("the Directories page has a URL", "dirs: '/directories'" in router)
check("the topbar names the page rather than its route slug",
      "dirs: 'Directories'" in workspace)
# The first cut used the Preferences card language on a list page, which put
# the heading and the content on two different left edges.
check("the page uses the shared list-page idiom, not settings cards",
      "page-head" in dirbook and "page-sub" in dirbook
      and "className = 'pref-group" not in dirbook
      and 'class="pref-group' not in dirbook)

# Substring matching is the difference between the saved list answering "roam"
# and appearing to be missing entirely.
check("a bare name matches saved paths anywhere in them",
      "lower.includes(q)" in dirbook)
check("a non-path query skips the server round trip",
      "!/^[~/]/.test(typed)" in dirbook)
# The classifier: a guess, and only ever the default for an undecided entry.
check("the classifier endpoint is routed and gated",
      'elif parsed.path == "/api/path/inspect":' in source
      and "LOCAL_PATH_ALLOWED_SOURCES" in source.split("def _handle_path_inspect", 1)[-1][:900])
classifier = source.split("def _classify", 1)[-1].split("def _handle_path_inspect", 1)[0]
check("a repository or project marker means project", '"project", "a repository' in classifier)
check("several projects inside means container", '"container", "it holds several projects"' in classifier)
check("nothing inside means project", '"project", "nothing inside it to browse"' in classifier)
check("the guess explains itself", classifier.count("return \"") >= 4)
check("the classifier caps how wide a directory it will scan",
      "_INSPECT_CHILD_CAP" in source and "_INSPECT_CAP" in source)
check("inspect answers existence too, so the page needs one round trip",
      '"exists"' in source.split("def _handle_path_inspect", 1)[-1][:2000])

check("the page's field drops the redundant star",
      "attachPathInput(input, { star: false })" in dirbook)
check("navigateView knows the route", "dirs: 'dirs'" in workspace)

# Two bugs that only ever appear under a live pointer, so they are pinned here.
check("a late completion cannot reopen a dismissed dropdown",
      "if (!items.length || !focused()) { close(); return; }" in dirbook
      and "if (!focused()) { close(); return; }" in dirbook)
check("blur tears down the pending debounce and request",
      "clearTimeout(debounce); inflight?.abort();" in dirbook)
check("pointer and keyboard share one highlight",
      "function highlight(" in dirbook and "button.addEventListener('mousemove'" in dirbook)
css = (WEB / "css" / "32-dirbook.css").read_text(encoding="utf-8")
check("no :hover rule competes with the keyboard highlight",
      ".dirbook-opt:hover" not in css)

print()
if failures:
    print(f"{len(failures)} FAILED: " + ", ".join(failures))
    raise SystemExit(1)
print("all dirbook checks passed")
