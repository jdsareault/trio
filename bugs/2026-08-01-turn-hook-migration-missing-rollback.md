# Bug: `turn_hook` migration missing ROLLBACK before ALTER TABLE

**Date:** 2026-08-01
**Severity:** Warning — schema migration may fail or leave connection in inconsistent state
**Discovered during:** LOTC review of `phase-7-ui-updates` (Uruk-Hai, bug hunt)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

When the `last_turn_end` column does not yet exist on the `sessions` table (the transitional case where the DB predates the feature), the `nth_turn_hook.py` migration path attempts `ALTER TABLE` while a failed `UPDATE` statement is still active in the transaction. This can cause the migration to fail silently (caught by the outer `except Exception: return 0`), leaving the column un-added and the turn-end timestamp un-stamped.

## Root cause

`server/nth_turn_hook.py:75-88`:

```python
conn.execute("BEGIN IMMEDIATE")
try:
    conn.execute(
        "UPDATE sessions SET last_turn_end = ? WHERE fingerprint = ?",
        (now, session_id[:64]),
    )
except sqlite3.OperationalError:
    # DB predates the column — add it, then stamp
    conn.execute("ALTER TABLE sessions ADD COLUMN last_turn_end TEXT")  # <-- no ROLLBACK first
    conn.execute(
        "UPDATE sessions SET last_turn_end = ? WHERE fingerprint = ?",
        (now, session_id[:64]),
    )
conn.execute("COMMIT")
```

The `BEGIN IMMEDIATE` starts a transaction. When the `UPDATE` fails with `OperationalError` (no such column), the transaction is still active. In SQLite, a failed statement within a transaction is automatically rolled back at the statement level, but the transaction itself remains open. Executing `ALTER TABLE` (DDL) within an active transaction after a failed statement can work in some SQLite versions but is fragile and inconsistent with the pattern used elsewhere in the codebase.

Compare to `server/nth_activity_hook.py:281-285` which correctly does `ROLLBACK` before migrating:

```python
except sqlite3.OperationalError as e:
    ...
    try:
        conn.execute("ROLLBACK")
    except Exception:
        pass
    _migrate(conn)
    _apply(conn, event, session_id, tool_name, target, now)
```

## Fix

Add `ROLLBACK` before the `ALTER TABLE`, matching the `nth_activity_hook.py` pattern:

```python
except sqlite3.OperationalError:
    try:
        conn.execute("ROLLBACK")
    except Exception:
        pass
    conn.execute("ALTER TABLE sessions ADD COLUMN last_turn_end TEXT")
    conn.execute(
        "UPDATE sessions SET last_turn_end = ? WHERE fingerprint = ?",
        (now, session_id[:64]),
    )
```

Note: after `ROLLBACK`, the `COMMIT` on line 89 will be a no-op (no active transaction), which is fine. Alternatively, re-`BEGIN` after the `ALTER TABLE` if atomicity is desired.

## Verification

1. Start with a DB that does not have the `last_turn_end` column on `sessions`.
2. Run the turn hook.
3. If the bug is present, the column may not be added (the outer `except Exception: return 0` swallows the error).
4. After the fix, the column is added and the timestamp is stamped.

## Reviewer notes

The Uruk-Hai flagged this by comparing to the `nth_activity_hook.py` migration pattern. The outer `except Exception: return 0` on line 90 means the bug is silent — the hook fails, the column is never added, and every subsequent invocation hits the same failed path. The "best-effort: never disturb the host session" design means this degrades gracefully but never self-heals.
