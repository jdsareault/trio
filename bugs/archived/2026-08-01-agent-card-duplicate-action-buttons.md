# Bug: Agent card renders duplicate action buttons

**Date:** 2026-08-01
**Severity:** Warning — visual duplication, confusing UX
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness; Frodo, UX)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

Every agent card in the roster drawer shows its action button row (Details, wake/stop, delete, Message) twice. Clicking either duplicate fires the same handler.

## Root cause

`server/web/js/30-agents.js:82` appends the same `row` element twice:

```js
article.append(row); article.append(row);
```

A DOM node can only have one parent, so the second `append` moves the node — but because both calls target the same parent, the net effect is that the row appears once. However, this is still a clear copy-paste bug. In some browsers or future code changes, this could produce unexpected behavior.

**Update:** On closer inspection, since both appends target the same `article`, the second append is a no-op (the node is already a child). The visible symptom is a single row, not duplicates. However, the duplicate line is dead code that should be removed.

## Fix

Remove the duplicate `article.append(row);` on line 82.

## Verification

1. Open the agent roster.
2. Each agent card should have exactly one row of action buttons.
3. No console warnings about duplicate appends.

## Reviewer notes

Sauron and Frodo both flagged this. The practical impact is minimal (the second append is a no-op since the node is already a child of `article`), but it's a clear copy-paste error.
