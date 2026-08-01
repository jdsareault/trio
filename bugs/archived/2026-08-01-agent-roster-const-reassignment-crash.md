# Bug: Agent roster search crashes — `const` reassignment in `render()`

**Date:** 2026-08-01
**Severity:** Critical — runtime crash when searching agents
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

Typing into the agent roster search box throws a `TypeError: Assignment to constant variable.` in strict mode. The agent drawer stops rendering and the search filter never works.

## Root cause

`server/web/js/30-agents.js:95` declares `list` with `const`:

```js
const list = (agents || []).map(a => viewModel(a)).filter(matches);
if (state.agentsSearch) {
  const q = state.agentsSearch.toLowerCase();
  list = list.filter(vm => (vm.name + ' ' + vm.model + ' ' + vm.provider).toLowerCase().includes(q));
}
```

Line 98 reassigns `list = list.filter(...)`. In strict mode (enabled by `'use strict'` at line 2), this is a `TypeError`. The IIFE wraps the entire module in strict mode, so this always throws when `state.agentsSearch` is non-empty.

## Fix

Change `const list` to `let list` on line 95.

## Verification

1. Open the agent roster drawer.
2. Type any text into the "Search agents…" input.
3. If the bug is present, the console shows `TypeError: Assignment to constant variable.` and the list does not filter.
4. After the fix, the list filters by name/model/provider.

## Reviewer notes

Sauron traced the declaration and reassignment. The `const` was likely introduced when the search feature was added without noticing the later reassignment. Frodo also flagged the duplicate `article.append(row)` on line 82 (see separate bug report).
