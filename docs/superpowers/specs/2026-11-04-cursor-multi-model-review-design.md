# Cursor multi-model review

**Date:** 2026-11-04  
**Status:** Approved for planning  
**Branch:** `mc/cursor-multi-model-review-e019e6`  
**Approach:** Dedicated Cursor multi-review flow (B)

## Goal

When a **Cursor** session finishes a turn that **edited files**, MonoCode automatically starts **two read-only review sessions** in parallel: **Claude** plus **one other** installed provider chosen by usage headroom. When both reviewers settle, MonoCode posts a **short combined note** back into the Cursor session. Reviewers report only; Cursor or the user applies fixes.

## Non-goals

- Changing manual **Second opinion** (it may still edit files).
- Auto-review for non-Cursor harnesses.
- Letting auto-reviewers modify the working tree, format-write, or commit.
- Inventing Cursor usage meters or multi-account profiles.
- Replacing Ultrareview or PR automations.

## Approach

Add a dedicated **Cursor multi-review** path that reuses Second-opinion context helpers and continue-elsewhere headroom picking, but owns its own trigger, read-only prompts, pair tracking, and Cursor fan-in. Do not overload the may-fix Second opinion button or Mono completion batches.

## Architecture

| Piece | Responsibility |
|--------|----------------|
| Trigger (App / session idle hook) | Detect Cursor `busy → idle` with edited files; respect setting and dedupe |
| `cursorMultiReview` model | Reviewer pick, read-only prompts, pair registry, fan-in note text |
| Session launch | `openSessionBeside` + submit, with `focusNew = false` when Cursor should stay focused |
| Pair tracker | Wait for all child reviews to settle; queue note while Cursor is busy |
| Settings | Kill switch under Code review (default on) |

### Data flow

```text
Cursor turn ends (busy→idle)
  → turnEditedFiles nonempty?
  → setting on? not already reviewing this turn?
  → pick Claude + headroom peer
  → open 1–2 read-only review sessions beside Cursor
  → register pair (sourceSessionId, turnId, childIds)
  → each child settles → capture last assistant text
  → all settled → if Cursor busy, queue; else inject combined app note into Cursor
```

## Trigger

Fire only when all of the following hold:

1. Setting **Review Cursor turns with other models** is **on** (default **on**).
2. Source session `harness === "cursor"`.
3. Session transitions **busy → idle** after a completed turn (include Stop after edits landed on disk; exclude idle churn with no new turn).
4. Latest user turn’s blocks yield **≥ 1 edited file** via existing `turnEditedFiles` (same as Second opinion).
5. That turn is **not** a multi-review fan-in / app notification (no loops).
6. No **in-flight pair** already registered for this `sourceSessionId` + latest turn’s user block id.

If no reviewer can be launched (Claude unavailable and no other live peer), skip quietly. Optional non-blocking toast: “Skipped auto-review — no other providers.”

## Reviewer selection

| Slot | Rule |
|------|------|
| **A — Claude** | Preferred Claude model for the project, if Claude is installed/live. |
| **B — Other** | Among installed, visible, live harnesses **excluding** `cursor` and `claude`, pick the lowest `harnessUsedPercent` (reuse `harnessUsedPercent` / continue-elsewhere options). Skip unknown usage when ranking; if none report usage, fallback order: `codex` → `grok` → first remaining live harness. |

Fallbacks:

- Claude missing, B present → launch **B only**.
- Only Claude → launch **Claude only**.
- Neither → skip.

At least one reviewer is required to proceed.

### Frontend bias (Claude prompt only)

If edited paths look UI-oriented, append a focus section to **Claude’s** prompt only. Slot B stays a general defect review.

Treat a path as frontend when any edited file matches (case-insensitive) extensions such as `.tsx`, `.jsx`, `.css`, `.scss`, `.sass`, `.less`, `.vue`, `.svelte`, `.html`, or path segments `/components/`, `/ui/`, `/styles/`. Keep the heuristic in one named helper so tests can pin it.

## Launch

Module: `src/features/sessions/model/cursorMultiReview.ts` (plus focused App wiring and tests).

1. Build context with existing Second-opinion helpers: `harnessForTurn`, `turnUserRequest`, `turnReport`, `turnEditedFiles`.
2. Build **read-only** prompts: same situational brief as Second opinion, plus an explicit ban: do not modify files, do not run write formatters, do not commit; report findings only (blockers, missing tests, disagreements with Cursor’s report).
3. Open each reviewer with `openSessionBeside`, same `cwd` / worktree as Cursor. Titles: `Review · {Harness}` (e.g. `Review · Claude`).
4. Extend open-beside with a **`focusNew`** (or equivalent) flag defaulting to today’s behavior for Second opinion; multi-review passes **`false`** so Cursor keeps focus when it was focused.
5. Persist lightweight metadata on review sessions / user blocks, e.g. `cursorMultiReview: { sourceSessionId, turnId, pairId, role: "claude" | "peer" }`, and card kind `"cursor-multi-review"` so UI can badge Auto-review without looking like a fix-capable Second opinion.
6. Submit prompts immediately after create.

Manual Second opinion remains unchanged and may still edit.

## Fan-in (combined note into Cursor)

Pair tracker patterned on `MonoSessionCompletionBatches`, owned by multi-review (do not overload Mono batches):

1. Register every launched child under `pairId` with `sourceSessionId` + `turnId`.
2. When a child goes idle (completed, failed, cancelled, or limited), capture its last non-tool assistant text (hard cap **3_000** characters per child).
3. When **all** registered children have settled:
   - If the Cursor session is **busy**, **queue** the combined note until Cursor is idle.
   - Else inject **one** app notification turn into Cursor (not user-authored), summarizing both reports.
4. Mark the source turn as reviewed for that pair so a later idle does not re-fire.
5. If the Cursor session was closed or deleted before fan-in, **drop** the note; leave review sessions readable on their own.

### Combined note shape

Short, actionable, read-only:

```text
Multi-review of your last turn is ready (read-only).
Consensus and disagreements below. Apply fixes you agree with; do not redo the whole task.

## Claude
…

## {PeerTitle}
…
```

Include child status when a reviewer failed or was cancelled. Truncate aggressively; point at the review session titles/ids if more detail is needed.

Queue multiple pairs in **turn order** if Cursor runs successive editing turns before prior reviews finish.

## Settings & UX

- **Settings → Code review:** toggle **Review Cursor turns with other models**, default **on**.
- Description: after Cursor edits files, Claude and another provider review in parallel; a summary returns to Cursor.
- Review sessions appear in the sidebar like other chats; optional subtle **Auto-review** badge from metadata.
- Do not remove or rename the existing Second opinion control.

## Error handling & edges

| Edge | Behavior |
|------|----------|
| Cursor Stop after edits | Still review (files on disk). |
| Rapid Cursor turns | One pair per editing turn; fan-in notes queue in order. |
| Reviewer hits usage limit | Child settles as failed/limited; combined note still posts with available text. |
| Worktree removed | Skip launch. |
| Remote sessions | Same rules if Second opinion already works there; otherwise desktop-only for v1 (document in plan). |
| Only one reviewer | Fan-in note has a single section; still posts. |

## Testing

- **Unit (`cursorMultiReview`):** trigger gates; reviewer pick (usage + fallbacks); frontend path heuristic; read-only prompt wording; pair settle; queue-while-Cursor-busy; loop prevention; Claude-only / peer-only fallbacks.
- **App / integration-style:** Cursor busy→idle with edits launches the expected sessions without stealing focus; fan-in writes one note into Cursor; skip when setting off or no providers.
- **Regression:** manual Second opinion prompt still allows fixes; continue-elsewhere headroom helper unchanged in behavior for its own callers.

## Implementation note

After this spec is reviewed, produce an implementation plan (`writing-plans`) that phases: (1) pure model helpers + tests, (2) App trigger + launch + focus flag, (3) pair tracker + fan-in queue, (4) settings toggle + badge, (5) verification.
