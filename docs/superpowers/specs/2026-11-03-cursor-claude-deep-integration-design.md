# Cursor + Claude deep integration (coordinated)

**Date:** 2026-11-03  
**Status:** Approved for planning  
**Branch:** `mc/improve-code-review-efficiency-4646c8` (coordinated workstreams on one branch)

## Goal

Deepen Cursor’s MonoCode integration toward Claude Code’s product depth, while also auditing and improving Claude Code integration. Ship both under one coordinated design with parallel workstreams.

## Approach

**Shared harness events, provider-specific fill.** Extend and honor the common harness surface Claude already uses (`context`, `background.updated`, `usage.limited`, `compactContext`, optionally `restoreTaskLists`). Cursor emits what ACP/CLI can provide; UI keys off capabilities and shared events—not `if (harness === "claude")` sprawl—except where a Claude-native artifact has no Cursor analogue (status script, Anthropic multi-account profiles).

**Capability rule:** If Cursor cannot provide a signal, UI stays hidden or “unknown”. No fake meters, no hollow compact button.

## Architecture

| Stream | Focus | Primary touches |
|--------|--------|-----------------|
| **A** Session feel | Cursor → `context`, `background.updated`; `compactContext` only if ACP/CLI supports it | `cursor.ts`, `cursorAdapter.ts`, composer/`canCompactHarnessContext` |
| **B** Limits & handoff | Cursor usage → limit UX + usage-aware continue-elsewhere (Claude/Codex/Cursor pool) | `extraUsage`, `apply.ts`, `continueUsage` / `continueElsewhere`, footer |
| **C** Settings surface | MCP / composer health for Cursor when real; statusline stays Claude-script-only | `McpSettings`, `Composer` mcp picker, statusline gates |
| **D** Claude upgrades | Audit + deepen Claude day-to-day (stream usage, accounts, remote/status, compact/background) without breaking shared contracts | `claude.ts`, `claudeStreamUsage`, accounts/statusline |

Product UI never invents provider-specific parallel event types when the shared `HarnessEvent` / adapter hooks already exist.

## Workstreams & data flow

### A — Session feel (Cursor)

1. Parse ACP `session/update` (and related notifications) for usage/context fields; emit `{ type: "context", used?, window? }` when known.
2. When the turn has yielded but Cursor background agent tools are still running, emit `{ type: "background.updated", tasks }` using the same wait semantics as Claude’s `syncBackgroundWait` (debounce on a joined key).
3. Probe compact: if Cursor exposes a compact / slash / ACP method, implement `compactContext` on `cursorAdapter`. Composer already gates on `canCompactHarnessContext`. If unsupported, omit the hook.

### B — Limits & handoff

1. Keep dashboard Auto/API bars as Cursor’s used percent (`harnessUsedPercent` / `getExtraUsage("cursor")`).
2. On clear Cursor limit-class errors, apply `usage.limited` with `cursorUsageResetsAt` (period end).
3. Continue-elsewhere: Claude / Codex / Cursor pool; pick live candidate with lowest used%; fallback Cursor→Claude, Claude↔Codex.
4. Footer: Cursor chip when the active session is Cursor; All usage panel unchanged.
5. **Out of scope:** Cursor multi-account profiles (CLI has no isolated profile model comparable to Claude/Codex).

### C — Settings surface

1. MCP: Cursor already appears in MCP provider lists; wire composer MCP picker health for Cursor only when status is readable (mirror `claudeHealth` pattern without faking health).
2. Statusline: Claude Code status script remains Claude-only; Cursor may show non-script extras (e.g. limits/links) that don’t require that script.
3. Do not invent Cursor account profiles in settings.

### D — Claude upgrades

1. Audit Claude-only paths for real gaps vs polish: stream usage merge (`stillRunning` / weekly-only plans), auto-account and exhausted-switch hints, remote-control / status extras, compact and background reliability.
2. Land only changes that improve day-to-day Claude sessions and preserve shared contracts Cursor depends on (`HarnessEvent`, `apply.ts`, continue/usage helpers).

## Error handling & edges

- **Missing ACP fields:** Do not emit; context ring / background wait stay empty.
- **Compact unavailable:** Adapter omits `compactContext`; UI hidden via `canCompactHarnessContext`.
- **Cursor usage fetch fails:** Extra usage stays `error`/`idle`; continue-elsewhere falls back to preferred pairing.
- **Limit false positives:** Only clear Cursor limit phrases / structured signals map to `usage.limited`.
- **Background flapping:** Debounce on joined task-key (Claude pattern).
- **Claude stream usage:** Partial windows must not wipe a still-running sibling; weekly-only plans must not resurrect a stale 5h window.
- **MCP health unknown:** List servers without a fake healthy badge; Claude connection errors stay Claude-scoped.
- **Parallel collisions:** Streams share types/events only; no drive-by edits in another stream’s files without coordinating on shared contracts (`types.ts`, `apply.ts`, continue/usage helpers).

## Testing

- **A:** Cursor `session/update` fixtures → `context` / `background.updated`; compact registered only when implemented; `canCompactHarnessContext("cursor")` false otherwise.
- **B:** `continueElsewhere`, `usageLimit`, `extraUsage` — pool membership, headroom pick, reset time, non-limit errors ignored.
- **C:** MCP/composer — Cursor paths don’t break Claude; unknown health doesn’t crash.
- **D:** Regression tests for any Claude stream-usage / account-switch fix.
- **Shared:** `apply.ts` coverage for new Cursor-emitted events; targeted vitest per stream; branch `tsc --noEmit`.
- **Optional / manual:** Live Cursor ACP smoke (not required for CI).

## Non-goals

- Replacing Cursor ACP with a Claude-style stream-json protocol.
- Fake context meters or compact when the CLI doesn’t expose them.
- Cursor multi-account profiles.
- Running Claude’s statusline script for non-Claude harnesses.

## Implementation note

After this spec is reviewed, produce an implementation plan (`writing-plans`) that schedules A–D as parallel workstreams on this branch with explicit shared-contract owners and merge order for shared files.
