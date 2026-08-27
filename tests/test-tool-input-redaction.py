"""Coverage for the opt-in redacted tool-input capture (NTH_CAPTURE_TOOL_INPUT).

The redactor is the security boundary for this feature: when capture is on it
decides what lands, permanently, in a shared plaintext SQLite file that every
local agent can read. It is best-effort by construction (a deny-list), so these
tests pin two things — that the shapes we DO claim to catch stay caught, and
that ordinary arguments survive, since a redactor that eats everything makes
the panel useless rather than safe.
"""
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

os.environ["NTH_CAPTURE_TOOL_INPUT"] = "1"
import nth_activity_hook as hook  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def bash(cmd):
    return hook._detail("Bash", {"command": cmd})


R = hook._REDACTED

# ── the default is off ────────────────────────────────────────────────────────
# The whole point of the flag is that an upgrade cannot silently start
# capturing arguments, so this is the single most important assertion here.
hook._CAPTURE_TOOL_INPUT = False
check("capture is off unless explicitly enabled",
      bash("curl https://api.example.com?api_key=sk-live-a93fQ2xKpLmNbVcXz") == "")
check("the short summary is unaffected by the flag",
      hook._summarize_target("Bash", {"command": "git status"}) == "git")
hook._CAPTURE_TOOL_INPUT = True

# ── secrets that must not survive ─────────────────────────────────────────────
SECRETS = [
    ("openai-style key in a query param",
     "curl https://api.example.com/v2/runs?api_key=sk-live-a93fQ2xKpLmNbVcXzAsDfGhJ",
     "sk-live-a93fQ2xKpLmNbVcXzAsDfGhJ"),
    ("github token in an Authorization header",
     "curl -H 'Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a' https://api.github.com",
     "ghp_16C7e42F292c6912E7710c838347Ae178B4a"),
    ("aws secret in a leading env assignment",
     "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX aws s3 ls",
     "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX"),
    # No key name, no flag, too short and too word-like for entropy — it is
    # caught only by the URL-authority rule, and connection strings are one of
    # the likeliest real shapes.
    ("password inline in a connection string",
     'psql postgres://admin:hunter2@db.internal:5432/prod -c "select 1"',
     "hunter2"),
    ("password behind a sensitive flag",
     "mysql -u root --password hunter2trombone --host db",
     "hunter2trombone"),
    ("aws access key id by marker",
     "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
     "AKIAIOSFODNN7EXAMPLE"),
    ("slack bot token by marker",
     "curl -d token=xoxb-2401-4028-abcdefghijklmnop https://slack.com/api/auth.test",
     "xoxb-2401-4028-abcdefghijklmnop"),
    ("a jwt by shape",
     "curl -X POST https://x.example.com "
     "-A eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
     "eyJhbGciOiJIUzI1NiJ9"),
    # Deliberately NOT vendor-shaped: this case exercises the entropy gate, not
    # a marker, so a realistic `sk_live_...` prefix bought nothing and tripped
    # GitHub's push protection (it scans for exactly that shape). Every fixture
    # in this file is synthetic; keep them clear of real vendor patterns or the
    # branch cannot be pushed.
    ("a bare positional random, caught by entropy",
     "deploy-tool Zq7Kw2Pv9Lm4Rt6Yx1Nb8Hj3Fd5Gs0A --region us-east-1",
     "Zq7Kw2Pv9Lm4Rt6Yx1Nb8Hj3Fd5Gs0A"),
    ("a private key header",
     "echo '-----BEGIN RSA PRIVATE KEY-----' > /tmp/k.pem",
     "BEGIN RSA PRIVATE KEY"),
]
for name, cmd, secret in SECRETS:
    out = bash(cmd)
    check(f"redacts: {name}", secret not in out and R in out)

# The generic MCP fallback runs through the same redactor.
check("redacts a secret in an unknown tool's arguments",
      "sk-live-a93fQ2xKpLmNbVcXzAsDfGhJ" not in
      hook._detail("mcp__x__call", {"endpoint": "https://x.dev",
                                    "api_key": "sk-live-a93fQ2xKpLmNbVcXzAsDfGhJ"}))

# ── ordinary arguments that must survive ─────────────────────────────────────
# Over-redaction is the safe direction for a credential and the WRONG direction
# for everything else: a panel that renders `[redacted] [redacted]` answers no
# question at all, which is the failure this feature exists to fix.
KEPT = [
    ("a plain git command", "git worktree add -b feat/x ../y main", "worktree"),
    ("a quoted commit message", 'git commit -m "fix the parser"', "fix the parser"),
    ("a repo slug behind a flag", "gh pr list --repo anthropics/claude-code", "anthropics/claude-code"),
    ("a pipeline", "grep -rn tool_events server/ | head -20", "tool_events"),
    ("a long file path", "sed -n '1,80p' /Users/jd/Development/trio/server/nth_web.py", "nth_web.py"),
]
for name, cmd, kept in KEPT:
    out = bash(cmd)
    check(f"keeps: {name}", kept in out)

check("keeps an ordinary key=value pair in an MCP call",
      "channel=trio-agent-details" in
      hook._detail("mcp__nth-trio__trio_send",
                   {"channel": "trio-agent-details", "member_id": "ag_5c3cbc"}))
# Message bodies are sprawl, not detail — excluded regardless of secrets.
check("never renders a message body",
      "hello there" not in
      hook._detail("mcp__nth-trio__trio_send",
                   {"channel": "c", "message": "hello there"}))
check("never renders an edit's replacement text",
      "def evil" not in
      hook._detail("Edit", {"file_path": "/tmp/a.py", "new_string": "def evil(): pass"}))

# ── shape ─────────────────────────────────────────────────────────────────────
# _summarize_target refuses any command containing a substitution, because it
# stores a PROGRAM NAME and a substitution makes that unknowable. The long form
# has no such problem: `$(cat ~/.netrc)` is literal text, and the interpolation
# happens in the shell long after this row is written.
check("the long form keeps a command with a shell substitution",
      "$(cat ~/.netrc)" in bash("X=$(cat ~/.netrc) deploy --region us-east-1"))
check("the short summary still refuses one",
      hook._summarize_target("Bash", {"command": "X=$(cat ~/.netrc) deploy"}) == "")
check("a file read carries its full path and span",
      hook._detail("Read", {"file_path": "/a/b/nth_web.py", "offset": 4766, "limit": 40})
      == "/a/b/nth_web.py:4766+40")
check("detail is capped so one row cannot bloat the ring",
      len(bash("run " + "x" * 5000)) <= hook._DETAIL_MAX)
check("detail is single-line — a newline would break the row",
      "\n" not in bash("run one\nrun two"))
check("a non-dict tool_input degrades to empty, never raises",
      hook._detail("Bash", None) == "" and hook._detail("Bash", "oops") == "")

# ── the entropy gate, whose tuning is the whole false-positive story ─────────
check("high-entropy long tokens with a digit are redacted",
      hook._redact("aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=") == R)
check("a lowercase slug with no digit is left alone",
      hook._redact("anthropics/claude-code") == "anthropics/claude-code")
check("an absolute path is never entropy-redacted",
      hook._redact("/Users/jd/Development/trio/server/nth_activity_hook.py")
      == "/Users/jd/Development/trio/server/nth_activity_hook.py")
check("short tokens are below the gate",
      hook._redact("ag_5c3cbc6ebcea") == "ag_5c3cbc6ebcea")

# ── performance, which is a correctness property here ────────────────────────
# This runs on PreToolUse, on the critical path of EVERY tool call, against the
# hook's 50ms budget. An unbounded quantifier in _KV_RE made a 1000-char
# argument with no `=` in it cost 17ms on its own, rising with the square of
# the input — so a long command line could have stalled the host's tool. These
# pin the two properties that keep it linear and bounded.
def _worst(n):
    blob = "a" * n
    t = time.perf_counter()
    bash(blob)
    return (time.perf_counter() - t) * 1000.0


slow_1k = max(_worst(1000) for _ in range(3))
check(f"a 1000-char argument redacts well inside the hook budget ({slow_1k:.1f}ms)",
      slow_1k < 15.0)
# The scan window is what makes this flat rather than merely slow: a 50KB
# heredoc must cost no more than the 4KB one, because both are truncated to
# _DETAIL_SCAN_MAX before any regex runs.
big, huge = max(_worst(4000) for _ in range(3)), max(_worst(50000) for _ in range(3))
check(f"cost is bounded by the scan window, not the input ({big:.1f}ms vs {huge:.1f}ms)",
      huge < big * 2 + 5.0)
check("the scan window is enforced, not just documented",
      hook._DETAIL_SCAN_MAX <= 4000 and hook._DETAIL_MAX <= 1000)
# A realistic command is the case that actually runs a few hundred times an
# hour per agent; it should be microseconds, not milliseconds.
t = time.perf_counter()
for _ in range(200):
    bash("curl -H 'Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a' "
         "https://api.github.com/repos/a/b/pulls?state=open")
per_call = (time.perf_counter() - t) / 200 * 1000.0
check(f"a realistic command costs well under a millisecond ({per_call:.3f}ms)",
      per_call < 1.0)

print()
print(("FAILED" if failures else "OK") + f" — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
