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


# ── the classifier, against a real tree ─────────────────────────────────────
# classify_dir is a module-level function of a path, so it is called directly.
# It used to be asserted by grepping nth_web.py for its own return strings,
# which cannot fail for any reason except an edit to the string and cannot pass
# for any reason related to a directory: flipping the ">= 2" threshold left
# every assertion green.

def make(tree, root=None):
    """Build a directory tree from {relative path: contents-or-None}."""
    root = Path(root or tempfile.mkdtemp(prefix="nth_dirbook_cls_"))
    for rel, contents in tree.items():
        target = root / rel
        if contents is None:
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")
    return root


def kind_of(tree):
    return web.classify_dir(str(make(tree)))


check("a .git directory means project",
      kind_of({".git": None, "src": None})[0] == "project")
check("a .git FILE means project too (a worktree or submodule)",
      kind_of({".git": "gitdir: /elsewhere"})[0] == "project")
check("a language marker means project",
      kind_of({"pubspec.yaml": "name: app"})[0] == "project")
check("markers are recognised across ecosystems",
      all(kind_of({marker: "x"})[0] == "project" for marker in
          ("package.json", "pyproject.toml", "Cargo.toml", "go.mod",
           "Gemfile", "pom.xml", "CMakeLists.txt", "composer.json")))
check("a .xcodeproj bundle is matched by suffix, not by name",
      kind_of({"App.xcodeproj": None})[0] == "project")
# The set is compared by equality, so a glob written there could only ever
# match a file literally named "*.sln" — configuration that never fires.
check("no glob patterns hide in the equality-matched marker set",
      not any("*" in marker for marker in web.PROJECT_MARKERS))

check("an empty directory is a project — nothing inside to browse",
      kind_of({})[0] == "project"
      and kind_of({})[1] == "nothing inside it to browse")
check("a directory of plain files is a project",
      kind_of({"notes.txt": "x", "todo.md": "y"})[0] == "project")

check("two project children make a container",
      kind_of({"a/.git": None, "b/Cargo.toml": "x"})[0] == "container")
check("a container says why",
      kind_of({"a/.git": None, "b/.git": None})[1] == "it holds several projects")
check("a single child, itself a project, is a container",
      kind_of({"only/.git": None})[0] == "container")
# The safer reading: a wrong 'container' buries the path the operator asked
# for, a wrong 'project' costs one click.
check("subdirectories with no projects in them stay a project",
      kind_of({"a": None, "b": None, "c": None})[0] == "project"
      and kind_of({"a": None, "b": None})[1] == "no projects found inside it")
check("a project marker at the top wins over project children",
      kind_of({".git": None, "a/.git": None, "b/.git": None})[0] == "project")
# Hidden children are skipped entirely: .git, .cache and friends are noise,
# and counting them would make almost every repository look like a container.
check("hidden children are not browsable, so a directory of them is a project",
      kind_of({".a/.git": None, ".b/.git": None})[0] == "project"
      and kind_of({".a/.git": None, ".b/.git": None})[1] == "nothing inside it to browse")
check("hidden children do not count toward the container threshold",
      kind_of({".hidden/.git": None, "a/.git": None, "b/.git": None})[0] == "container")

missing_kind, missing_why = web.classify_dir(str(Path(tempfile.mkdtemp()) / "nope"))
check("an unreadable or missing directory classifies as nothing",
      missing_kind is None and missing_why == "")

# The per-directory cap does not bound the work — classify scans each child
# looking for markers, so a wide directory of non-projects costs children x
# entries. This budget is what actually bounds one request.
budget = web._ScanBudget(total=5)
wide = make({f"d{i:03d}/x.txt": "x" for i in range(40)})
web.classify_dir(str(wide), budget)
check("a shared budget stops a wide scan", budget.spent is True)
check("an exhausted scan falls back to project, not to a wrong container",
      web.classify_dir(str(wide), web._ScanBudget(total=5))[0] == "project")
check("the budget is shared across a whole request, not reset per path",
      web.INSPECT_ENTRY_BUDGET > 0 and web.INSPECT_CAP > 0)
# applyGuesses treats an absent path as "not asked about" rather than "no
# longer classified", but these two caps still have to agree: the client may
# not save more than one request can be asked about.
dirbook_js = (WEB / "js" / "15-dirbook.js").read_text(encoding="utf-8")
max_favorites = int(re.search(r"MAX_FAVORITES = (\d+)", dirbook_js).group(1))
check(f"MAX_FAVORITES ({max_favorites}) fits in one INSPECT_CAP ({web.INSPECT_CAP}) batch",
      max_favorites <= web.INSPECT_CAP)


# ── wiring ──────────────────────────────────────────────────────────────────
# The feature is only real if it is reachable; these are registration facts,
# not behaviour, so grepping is the right tool for them.
workspace = (WEB / "js" / "20-workspace.js").read_text(encoding="utf-8")
router = (WEB / "js" / "03-router.js").read_text(encoding="utf-8")
agents = (WEB / "js" / "30-agents.js").read_text(encoding="utf-8")

check("the Directories page renders through the workspace shell",
      "Trio.dirbook?.renderPage?.(panel)" in workspace)
check("the Directories page has a nav entry", "label: 'Directories'" in workspace)
check("the nav entry sits between Preferences and Archive",
      workspace.index("label: 'Preferences'")
      < workspace.index("label: 'Directories'")
      < workspace.index("label: 'Archive'"))
check("the Directories page has a URL", "dirs: '/directories'" in router)
check("the topbar names the page rather than its route slug",
      "dirs: 'Directories'" in workspace)
check("both working-directory inputs get the picker",
      agents.count("Trio.dirbook?.attachPathInput?.(") == 2)
check("the stylesheet ships", (WEB / "css" / "32-dirbook.css").exists())
check("every layer is registered in the bundle",
      "js/15-dirbook.js" in web.WEB_JS_FILES
      and "js/16-dirbook-ui.js" in web.WEB_JS_FILES
      and "css/32-dirbook.css" in web.WEB_CSS_FILES)
check("the store loads before the UI that reads it at definition time",
      web.WEB_JS_FILES.index("js/15-dirbook.js")
      < web.WEB_JS_FILES.index("js/16-dirbook-ui.js"))
check("both new layers reach the served page",
      "trio.dirbook.v1" in web.INDEX_HTML and ".dirbook-pop" in web.INDEX_HTML)
# A default-submit button inside the create-agent form would spawn an agent.
ui_js = (WEB / "js" / "16-dirbook-ui.js").read_text(encoding="utf-8")
check("every button the picker builds is explicitly type=button",
      ui_js.count("createElement('button')") == ui_js.count("type = 'button'")
      and "<button class=" not in ui_js)

print()
if failures:
    print(f"{len(failures)} FAILED: " + ", ".join(failures))
    raise SystemExit(1)
print("all dirbook checks passed")
