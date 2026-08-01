# Bug: DM endpoint fetches 2000 rows and loops twice per thread request

**Date:** 2026-08-01
**Severity:** Warning — O(n) latency on every DM thread load, scales poorly
**Discovered during:** LOTC review of `phase-7-ui-updates` (Legolas, performance)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

Loading a specific DM thread (`/api/dms?with=<key>`) fetches the last 2000 DM messages across ALL channels, then loops over them twice — once to find the latest message ID for the requested thread, and again in reverse to collect the thread's messages. This is O(n) where n=2000 for every DM thread load, regardless of how many messages are in the requested thread.

## Root cause

`server/nth_web.py:3262-3264` — the initial query:
```python
rows = db.execute(
    "SELECT * FROM messages WHERE recipients IS NOT NULL "
    "AND recipients NOT IN ('', '[]') ORDER BY id DESC LIMIT 2000"
).fetchall()
```

`server/nth_web.py:3324-3337` — the double loop when `with_id` is set:
```python
latest = 0
for r in rows:                                    # loop 1: find latest id
    key, _others = dm_thread_key(r, operator_id)
    if key == requested_key:
        latest = max(latest, r["id"])
...
for r in reversed(rows):                          # loop 2: collect messages
    key, _others = dm_thread_key(r, operator_id)
    if key == requested_key:
        evt = _message_event(db, r)
        ...
```

Even when loading a single thread with 10 messages, the code scans all 2000 rows twice, calling `dm_thread_key()` (which parses JSON recipients) on each row.

The same 2000-row scan also powers the DM list endpoint (no `with` parameter), where it builds the `yours` and `agent_threads` dictionaries — a single O(n) pass that is reasonable for listing, but wasteful for loading a single thread.

## Fix

For the `with_id` case, use a targeted query that filters by operator participation:

```python
if with_id:
    rows = db.execute(
        "SELECT * FROM messages WHERE recipients IS NOT NULL "
        "AND recipients NOT IN ('', '[]') "
        "AND (member_id = ? OR recipients LIKE ?) "
        "ORDER BY id DESC LIMIT 500",
        (operator_id, f'%{operator_id}%')
    ).fetchall()
```

(Note: the `LIKE` filter is a rough pre-filter; `dm_thread_key` still needs to validate exact membership, but the candidate set is much smaller.)

Alternatively, add a `dm_threads` table that maps `(operator_id, thread_key)` → `latest_id`, updated on each DM insert, so the latest ID lookup is O(1).

## Verification

1. Create several DM threads with 100+ messages each.
2. Load a specific thread via `/api/dms?with=<key>`.
3. Measure response time — it should not scale with the total number of DMs across all threads.

## Reviewer notes

Legolas profiled the query pattern. The 2000-row LIMIT is a hard cap, but the double loop makes the constant factor 2x. The N+1 query pattern in the channel list endpoint (line 3156) is a separate but related performance concern.
