**Take:** the mockup's Project Home is the right page, but it's built around the wrong thing — a pretty progress bar over inferred status. The product is the ask queue plus a status that can be trusted. Everything else is garnish.

## 1. MUST
1. **One cross-session "Waiting on you" queue, tickable in place** — this is Sam's real question at 9am; the current per-session checklist sidebar can't answer "what needs me on Yap?".
2. **Roadmap read from `plan.md` with real phase IDs and a status enum, not prose** — hand-typed status sentences are the bug being fixed, not the model to preserve.
3. **Done-when checks per phase, editable inline** — they are the definition of done; the mockup treats them as expandable decoration.
4. **Status with provenance** ("set by Phase 2 chat, 5h ago, evidence: branch unmerged") and an override — staleness must be visible, not hidden behind "as of 2d ago".
5. **Many-to-many chat↔phase links, editable via a picker** — one chat often serves two phases, and one phase has four chats.
6. **Current phase as hero, done phases as one compact row each** — equal-weight 10-row lists are a reading tax.
7. **Sidebar shows needs-you count, not progress rings** — actionable beats decorative at the project list.
8. **A no-plan fallback view** (see §5) — most projects won't have `plan.md`, and a dashboard that's blank for them is dead weight.

## 2. CUT
- **The segmented bar.** Partial fills of 0.85/0.45, hover tooltips, click-to-jump, celebration glow: it's a progress bar wearing a dashboard costume. Partial fill encodes confidence in inferred data, the least trustworthy number on screen. A `3/10` header does the job.
- **"Live now" rail + "not linked" tray + chips inside phases.** Same sessions in three places. Keep chips-in-phase and one flat "loose chats" line.
- **Drag-to-link.** Hidden, unusable on a phone, and undefined for multi-phase chats. A chip menu is enough.
- **"Start phase" on `step-N-slug`.** Pre-creating a branch name the agent will inevitably diverge from (worktrees, squash, rebase, branch deleted on merge) manufactures the stale mapping you're trying to eliminate. Open a chat with the brief; let it branch.
- **Mini progress bar in the chat strip.** Ten pixels of duplicated info. Keep `Yap › Phase 3` + needs pill.
- **"Edit plan.md" opening a file viewer.** That's admitting the dashboard isn't editable.
- **Undo toasts on links.** Fine, low stakes. Spend the safety budget on status changes, which need confirm + audit, not undo.

## 3. Data model
`plan.md` stays canonical — agents read it, Sam sees it in git — but its table gets a contract: `ID | What | Done when | Status | Note`, status limited to `todo / in-progress / built / done / blocked`. A sidecar `.claude/roadmap.json` holds provenance and check state; MonoCode writes the status cell back through a `roadmap` tool, like the existing checklist tool.

**Kill "derive status from branches/sessions."** It fails in at least four ordinary cases: one phase spans several chats and chats span phases; worktree branch names are arbitrary and often deleted at merge; squash/rebase/cherry-pick and direct-to-main commits make "merged" ambiguous; and **merged ≠ done** — Yap's Phase 1 is built and tested but deliberately unmerged, while a merged half-feature isn't done at all. Inference may only *suggest* ("looks merged — mark done?"). A human or agent claim with a timestamp is the only status that survives a restart.

## 4. Layout + micro-interaction
One column: needs-you, then the current phase expanded with Done-when and chat chips, then a compressed done table — sidebar badges carry the cross-project view.

The micro-interaction that makes it true: **ticking the last Done-when check proposes Done and writes it back to `plan.md` in one click, with undo** — closing the loop is the only thing that keeps the status honest.

## 5. No `plan.md`
Don't fake a roadmap. Show an activity digest: open asks, sessions with their last note, branches/uncommitted work, what changed in 24h — plus "Draft `plan.md` from these sessions", generating a phase table for review. Never a zeroed bar or an empty roadmap.
