# Shared constants for the nth MCP server and event monitor.
# Both nth_server.py and nth_monitor.py import from here.

# Single source of truth for the release version. Surfaces in the startup
# banner, the hub's /healthz + /fleet endpoints, node check-ins, and
# nth_doctor's local-vs-hub version match.
import json
import re
import sqlite3
from pathlib import Path

NTH_VERSION = "8.1.1-beta.1"

SLEEPING_KEYWORDS = ("idle", "standing by", "tier 3", "agent-monitor")

# Hidden transport for managed agents. A supervised agent is launched with this
# as its channel so the hub can talk to it (prompts in, output back) without
# that traffic appearing in whatever room the agent is actually a member of.
# nth_server scopes every message here to its addressee, so a model that
# reaches for a plain broadcast cannot spill hub plumbing into a real channel.
AGENT_INBOX_CHANNEL = "nth-agent-inbox"

# Operator/human member ids carry this prefix. Only the two AUTHENTICATED
# tiers are all-seeing; a self-declared guest is not, and neither is an agent.
OPERATOR_MEMBER_ID_PREFIX = "_op_"
OPERATOR_ALL_SEEING_PREFIXES = ("_op_l_", "_op_t_")

# A legitimate recipient set is small. The cap bounds the work every read path
# does per message, so a malformed row cannot make reads expensive.
MAX_RECIPIENTS = 256


# ── Image attachment shared config + helpers ──────────────────────────
# THE single source for the attachment MIME allow-list, the size caps, the
# on-disk table shape, the magic-byte sniffer and the per-channel directory
# sanitizer. Both ingest routes — the web upload endpoint (nth_web.py) and
# the MCP agent send path (nth_server.py) — import from here so the two can
# never drift into allowing different types, writing a differently-shaped
# row, or scoping two different directories for the "same" channel.
#
# The attachment ROOT deliberately stays out of this module: nth_web derives
# it from the --db it was pointed at (attach_dir_for) and nth_server from its
# own DB_DIR, and both are monkeypatched per-module by the tests. Callers pass
# their own root as `base` instead.

# MIME → file extension. Doubles as the allow-list: a sniffed type absent
# from this map is rejected. png/jpeg/gif/webp only — the four formats the
# poll path can hand back to agents as MCP Image blocks.
IMAGE_MIME_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg",
    "image/gif": ".gif", "image/webp": ".webp",
}

# Per-file byte cap and per-message count cap, shared by both ingest paths.
MAX_ATTACH_BYTES = 10 * 1024 * 1024   # 10 MB hard cap per image
MAX_ATTACH_COUNT = 8                  # max images linked to one message

_CHANNEL_DIR_SANITIZE_RE = re.compile(r"[^\w.\-]")


def channel_attach_dir(channel: str, base: Path) -> Path:
    """The on-disk attachment directory for one channel, under `base`.

    THE single sanitizer for this path. The web upload/serve handlers, the
    per-agent --add-dir grant, and the agent send path must all route through
    it, or they drift into scoping two different directories for the same
    channel and an agent cannot read the files people share with it.

    `base` is explicit because each module owns its own attachment root (see
    the note above); there is no module-level default to fall back to."""
    return Path(base) / _CHANNEL_DIR_SANITIZE_RE.sub("_", channel or "")


def sniff_image_mime(data: bytes):
    """Real image MIME from magic bytes, or None if not a supported image.
    We trust the sniffed type over any client-declared Content-Type or file
    extension — the sniff is the security gate on both ingest paths."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def ensure_attachments_table(db: sqlite3.Connection) -> None:
    """Create the attachments table + its indexes on demand.

    THE canonical CREATE, shared by nth_web (upload) and nth_server (agent
    send). Both call it with IF NOT EXISTS, so whichever ingest path runs
    first wins and the other is a no-op — no ownership handoff needed."""
    db.execute(
        "CREATE TABLE IF NOT EXISTS attachments ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " channel TEXT NOT NULL,"
        " message_id INTEGER,"
        " member_id TEXT NOT NULL,"
        " mime TEXT NOT NULL,"
        " filename TEXT,"
        " width INTEGER, height INTEGER, bytes INTEGER,"
        " path TEXT NOT NULL,"
        " created_at TEXT NOT NULL)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_attachments_channel "
        "ON attachments(channel)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_attachments_unlinked "
        "ON attachments(created_at) WHERE message_id IS NULL"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_attachments_message "
        "ON attachments(message_id)"
    )


def is_all_seeing(reader_id, reader_kind=None) -> bool:
    """True ONLY for the authenticated dashboard operator — a loopback or
    tailnet identity (`_op_l_` / `_op_t_`). Guests (`_op_g_`), pending
    visitors (`_op_p_`) and agents are not: being human is not enough, only
    the verified operator identity is. Unknown `_op_` sub-prefixes fail
    CLOSED."""
    if not reader_id:
        return False
    return str(reader_id).startswith(OPERATOR_ALL_SEEING_PREFIXES)


# ── Message scoping ───────────────────────────────────────────────────
# A message may be addressed to specific members rather than the whole
# channel. THE predicate lives here, in the leaf module every side imports,
# so the "can this reader see this message" decision is made in exactly one
# place — copy-pasting subtly different filters into each read path is how a
# private message leaks.

def parse_recipients(raw) -> list:
    """messages.recipients -> list of member_ids. Empty/NULL/'[]' means
    broadcast. Anything unparseable also returns [] — fail OPEN to broadcast,
    because a corrupt value must never silently hide a message from everyone.
    Capped: a legitimate recipient set is small, and an unbounded list here
    would be a cheap way to make every read path do unbounded work."""
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw][:MAX_RECIPIENTS]
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if isinstance(v, list):
        return [str(x) for x in v][:MAX_RECIPIENTS]
    return []


def can_see(reader_id, reader_kind, sender_id, recipients_raw,
            allow_all_seeing=True) -> bool:
    """Whether reader R may see message M. True iff ANY of:
      * M is a broadcast (recipients empty), or
      * R is the sender, or
      * R is in M's recipients, or
      * R is all-seeing AND that is permitted here.

    allow_all_seeing is False on every agent-facing path, because those
    identify their caller only by a member_id the caller supplies and the
    server cannot authenticate."""
    if allow_all_seeing and is_all_seeing(reader_id, reader_kind):
        return True
    recips = parse_recipients(recipients_raw)
    if not recips:
        return True  # broadcast
    if reader_id is not None and reader_id == sender_id:
        return True
    return reader_id in recips


def narrow_wake(wake_ids, recipient_ids, sender_id):
    """For a scoped (DM) message, drop wake targets who aren't participants.

    THE wake-vs-visibility invariant: a message may never WAKE someone who
    cannot SEE it. A scoped message (non-empty recipients) is private to those
    recipients plus the sender; anyone else named via @/#/! can't see it, so
    waking them is the mentions⊄recipients bug — the woken-but-blind symptom
    where an agent is pinged into a thread it can't read. This mirrors Slack:
    mentioning someone who isn't in the DM/channel is inert text, not a ping.

    Returns wake_ids filtered to the participant set (recipients ∪ sender),
    order preserved. A broadcast (empty recipient_ids) is returned unchanged,
    so public-channel @/#/! wake semantics are untouched. The predicate is the
    exact complement of can_see's scoped branch, so wake can never drift from
    visibility."""
    if not recipient_ids:
        return list(wake_ids)
    participants = set(recipient_ids)
    if sender_id is not None:
        participants.add(sender_id)
    return [w for w in wake_ids if w in participants]


# ── Context snapshot projection ───────────────────────────────────────
# Statusline/publisher snapshots carry far more than the UI renders:
# transcript paths, working directories, project dirs and cumulative API
# spend. Those reach unauthenticated viewers over /api/events and
# /api/landing, and the relayed blob is caller-controlled, so both the
# store side (nth_server) and the read side (nth_web) project onto this
# allowlist. Add a key here only when the UI actually renders it.
CONTEXT_ALLOWED_KEYS = (
    "session_id", "session_name", "used_pct", "cw_size",
    "model", "effort", "source", "ts", "last_event_ts", "data_age_s",
    "_age_s", "_relayed_at",
)
# Nested under "harness": only the two subtrees the drill-down reads.
CONTEXT_ALLOWED_HARNESS = ("context_window", "rate_limits")
# Longest string we keep for any scalar field — a relayed snapshot is
# untrusted input, and these all render into a narrow stats column.
CONTEXT_MAX_STR = 200


def project_context(ctx):
    """Return a copy of a context snapshot with only renderable fields.

    Drops unknown keys entirely (so a hostile or future-expanded payload
    cannot ride the relay into the page), coerces scalars to short
    strings/numbers, and keeps the two harness subtrees the UI reads.
    Returns None if the input is not a dict.
    """
    if not isinstance(ctx, dict):
        return None

    def _scalar(v):
        if v is None or isinstance(v, (bool, int, float)):
            return v
        return str(v)[:CONTEXT_MAX_STR]

    def _clean(sub, depth):
        """Scalars, plus one more level of dict-of-scalars.

        rate_limits nests as {five_hour: {used_percentage: N}}, so a
        scalars-only filter here silently drops the 5h/7d rows.
        """
        cleaned = {}
        for k, v in sub.items():
            if isinstance(v, (str, int, float, bool, type(None))):
                cleaned[k] = _scalar(v)
            elif isinstance(v, dict) and depth > 0:
                cleaned[k] = _clean(v, depth - 1)
        return cleaned

    out = {}
    for key in CONTEXT_ALLOWED_KEYS:
        if key in ctx:
            out[key] = _scalar(ctx[key])

    harness = ctx.get("harness")
    if isinstance(harness, dict):
        keep = {}
        for key in CONTEXT_ALLOWED_HARNESS:
            sub = harness.get(key)
            if isinstance(sub, dict):
                keep[key] = _clean(sub, 1)
        if keep:
            out["harness"] = keep
    return out

# ── Animal emoji avatars ──────────────────────────────────────────────
# Stable, per-member visual identity. Curated to avoid confusable pairs
# (e.g. only one dog, one cat). Member_id hashes into this list to pick
# an avatar that stays the same for the life of the member row.
ANIMAL_EMOJIS = [
    ("fox",      "🦊"), ("panda",    "🐼"), ("owl",      "🦉"),
    ("octopus",  "🐙"), ("koala",    "🐨"), ("tiger",    "🐯"),
    ("lion",     "🦁"), ("wolf",     "🐺"), ("bear",     "🐻"),
    ("raccoon",  "🦝"), ("badger",   "🦡"), ("otter",    "🦦"),
    ("skunk",    "🦨"), ("deer",     "🦌"), ("bison",    "🦬"),
    ("goat",     "🐐"), ("ram",      "🐏"), ("horse",    "🐴"),
    ("unicorn",  "🦄"), ("zebra",    "🦓"), ("giraffe",  "🦒"),
    ("camel",    "🐪"), ("elephant", "🐘"), ("rhino",    "🦏"),
    ("hippo",    "🦛"), ("kangaroo", "🦘"), ("sloth",    "🦥"),
    ("hedgehog", "🦔"), ("bat",      "🦇"), ("rabbit",   "🐰"),
    ("mouse",    "🐭"), ("chipmunk", "🐿️"), ("beaver",   "🦫"),
    ("dog",      "🐶"), ("cat",      "🐱"), ("boar",     "🐗"),
    ("cow",      "🐮"), ("pig",      "🐷"), ("frog",     "🐸"),
    ("monkey",   "🐵"), ("gorilla",  "🦍"), ("orangutan","🦧"),
    ("rooster",  "🐓"), ("penguin",  "🐧"), ("duck",     "🦆"),
    ("swan",     "🦢"), ("eagle",    "🦅"), ("peacock",  "🦚"),
    ("parrot",   "🦜"), ("flamingo", "🦩"), ("dove",     "🕊️"),
    ("crocodile","🐊"), ("turtle",   "🐢"), ("snake",    "🐍"),
    ("lizard",   "🦎"), ("dragon",   "🐉"), ("trex",     "🦖"),
    ("whale",    "🐳"), ("dolphin",  "🐬"), ("shark",    "🦈"),
    ("fish",     "🐟"), ("crab",     "🦀"), ("lobster",  "🦞"),
    ("squid",    "🦑"),
]
# Invariant: list is a stable canonical order. Never reorder or insert
# in the middle — only append new animals at the end. Reordering would
# reassign every member's avatar.


def animal_for(member_id: str) -> tuple[str, str]:
    """Return (name, emoji) for a member_id. Deterministic and stable.

    No collision avoidance — two different member_ids can hash to the
    same slot. Use animal_for_channel() when rendering a roster where
    per-channel uniqueness matters.
    """
    h = 0
    for c in member_id or "":
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return ANIMAL_EMOJIS[h % len(ANIMAL_EMOJIS)]


def animal_for_channel(member_ids):
    """Assign a unique (name, emoji) to every member in a channel.

    Returns a dict {member_id: (name, emoji)}. Members are resolved in
    sorted member_id order (stable across reorderings of the input) and
    each collision linearly probes to the next free slot. When the
    roster exceeds the avatar pool (currently 63), later members wrap
    and collisions are unavoidable — they fall back to the plain hash
    pick for those overflow members only.
    """
    pool_size = len(ANIMAL_EMOJIS)
    taken = set()
    result = {}
    for mid in sorted(set(member_ids or [])):
        h = 0
        for c in mid or "":
            h = (h * 31 + ord(c)) & 0xFFFFFFFF
        start = h % pool_size
        pick = start
        for _ in range(pool_size):
            if pick not in taken:
                break
            pick = (pick + 1) % pool_size
        taken.add(pick)
        result[mid] = ANIMAL_EMOJIS[pick]
    return result
