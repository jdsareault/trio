# Shared constants for the nth MCP server and event monitor.
# Both nth_server.py and nth_monitor.py import from here.

import json

SLEEPING_KEYWORDS = ("idle", "standing by", "tier 3", "agent-monitor")

# ── Real DMs: the member-aware visibility predicate ───────────────────
# Lives here, in the module every side (nth_server, nth_web, nth_monitor)
# already imports, so the "can this reader see this message" decision is
# made in EXACTLY ONE place. Copy-pasting subtly-different filters into
# each read path is how a DM leaks — so every message read path routes
# through can_see() (or its recipients parse) instead.

# Operator/human member ids are prefixed with this. Kept in sync with
# nth_web.OPERATOR_MEMBER_ID_PREFIX; duplicated (not imported) because
# nth_constants is the leaf module everything else imports.
OPERATOR_MEMBER_ID_PREFIX = "_op_"


def is_all_seeing(reader_id, reader_kind) -> bool:
    """True if this reader sees every message regardless of addressing.

    The human operator is all-seeing so the audit trail stays complete
    (design decision: DMs are withheld from non-recipient *agents*, never
    from the operator). A reader is all-seeing when its member id is an
    operator id (``_op_`` prefix) OR its members.kind is anything other
    than 'agent' (humans join the dashboard as kind='human'). kind may be
    None on an un-migrated row — treat that as an agent (the safe default:
    an agent wrongly treated as all-seeing would leak, the reverse only
    over-withholds)."""
    if reader_id and str(reader_id).startswith(OPERATOR_MEMBER_ID_PREFIX):
        return True
    if reader_kind is not None and reader_kind != "agent":
        return True
    return False


def parse_recipients(raw) -> list:
    """Parse a messages.recipients column value into a list of member_ids.

    Empty / NULL / '' / '[]' all mean "broadcast" and return []. Anything
    unparseable also returns [] (fail OPEN to broadcast — a corrupt
    recipients value must never silently hide a message from everyone;
    [] is treated as broadcast by can_see, which matches today's
    every-member-sees-everything behavior). Accepts a raw JSON array
    string or an already-decoded list."""
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw]
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return []


def can_see(reader_id, reader_kind, sender_id, recipients_raw, allow_all_seeing=True) -> bool:
    """THE visibility predicate. A reader R may see message M iff ANY of:

      • M is a broadcast (recipients empty/NULL), OR
      • R is the sender (M.member_id == R), OR
      • R is in M.recipients, OR
      • R is all-seeing (operator / human — see is_all_seeing), IF permitted.

    recipients_raw is the raw messages.recipients column (JSON array string,
    or NULL/'' on pre-migration rows). Broadcasts (the common case) stay
    visible to everyone, so existing non-DM traffic is unaffected.

    allow_all_seeing: when False, the operator/human all-seeing branch is NOT
    applied — R sees only broadcasts, its own messages, and DMs addressed to
    it. The agent-facing MCP read paths (trio_poll / trio_history /
    trio_pounds / trio_connect) and the monitor pass False, because they
    identify their caller ONLY by a caller-supplied member_id they cannot
    authenticate. Without this, a forged operator/human id (a bare "_op_",
    or any real operator id — those are handed to every agent in the
    trio_connect roster) would satisfy is_all_seeing and let an agent harvest
    EVERY DM in one call. All-seeing is a property of the AUTHENTICATED
    web-dashboard operator surface, which leaves this True."""
    if allow_all_seeing and is_all_seeing(reader_id, reader_kind):
        return True
    recips = parse_recipients(recipients_raw)
    if not recips:
        return True  # broadcast — unchanged legacy behavior
    if reader_id is not None and reader_id == sender_id:
        return True
    return reader_id in recips

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
