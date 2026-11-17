Reviewing the mockup and relevant product surfaces to ground the debate.


## 1. MUST (max 8)

1. **Project-scoped “Waiting on you”** — merged open checklist items across sessions, with one tap into the session that created each item; that’s what Sam is actually checking from his phone.
2. **“As of …” on every non-live status line** — the mockup’s `◷ as of 2d ago` is non-negotiable; without it, derived UI gaslights him when agents drift.
3. **Session ↔ phase links persisted in app state** — not inferred from chat titles; otherwise Yap’s “Onboarding flow” stays orphaned forever.
4. **`docs/plan.md` as read-only structure on the dashboard** — phases, “done when,” and branch hints parsed once; humans don’t re-type the table.
5. **Handoff strip** — top of Project Home: last `handoff.md` heading + age + “what’s next”; sidebar rings alone don’t answer “where are we?”
6. **External / non-Claude sessions in the same chips** — `claims.py` notes and external session status must appear beside fork sessions or the dashboard is wrong half the time.
7. **Conflict surfacing** — two active sessions on the same phase branch, or checklist items that contradict git state, shown explicitly, not smoothed into one green dot.
8. **Sidebar project ring** — fractional roadmap done at a glance across 5–15 projects; the mockup gets this right and the main canvas is too heavy for that job.

---

## 2. CUT (blunt)

- **Drag-to-link tray + undo toasts** — PM cosplay. A “Link to phase…” menu on orphan chats gets 90% of the value without DnD state machines on v1.
- **Human-clickable “Done when” checkboxes on the dashboard** — either agents maintain them via a tool or they become Sam’s second job and diverge from `plan.md`.
- **“Merge and mark done” on Project Home** — wrong surface; merging is git, not roadmap UI. This button will get clicked on “built, not merged” phases and wreck history.
- **Triple progress chrome** — segmented bar + expandable phase list + chat-tab strip + sidebar rings is four answers to one question. Keep **rings in sidebar + one primary timeline on home**; demote or kill the tab strip popover until home is trusted.
- **“Live now” duplicate of session chips** — same sessions appear in the right column, phase bodies, and sidebar; one live cluster, linked from phases.
- **Celebration animations** — pretty demo, zero signal when you’re juggling fifteen agents.
- **Top-of-home “open in editor” for `plan.md`** as the hero action — editors are where lies get written; dashboard should *show* truth, not invite more prose status columns.

---

## 3. Data model (attack the derive-everything idea)

**Roadmap truth:** `docs/plan.md` (Kickoff’s artifact) remains canonical text; MonoCode keeps a **parsed index** (phase id, name, done-when bullets, optional `branch:` hint) invalidated on file mtime. Don’t let agents rewrite the Status column in markdown — that’s how you got “waiting on you journalling on it” novellas.

**Operational truth:** per-session metadata: `phaseId`, optional `branch`, last **status note** (claims / agent tool), checklist snapshot, harness state (working / waiting / idle). **Phase status is computed with a priority stack**, not a single rule:

| Signal | Use |
|--------|-----|
| Open checklist item tagged to phase | **Needs you** (wins over “in progress”) |
| Live tool turn on linked session | **In progress** |
| Agent `phase.progress` / handoff update | **Narrative + checks** (with timestamp) |
| Git: target branch merged to default | **Done** (only if you know the right default + merge detection) |
| Commits on phase branch, not merged | **Built, not merged** |

Pure **derive from `step-N-slug` branches + “live session”** is fragile: sessions that never checkout, renamed branches, worktrees, Codex in another cwd, phases without branches, and “done” that isn’t merge-shaped (phone soak tests) all break the model. Branch rules should be **hints that bump confidence**, not the sole state machine. When git and narrative disagree, show **both**, don’t pick a winner silently.

Linking unlinked chats: store `{ sessionId, phaseId, linkedAt }` in fork state; optional one-line agent summary on link — not drag-drop as the source of truth.

---

## 4. Layout

**One sentence:** Mobile-first column — **asks → current phase card (expanded) → collapsed future/past** — with desktop adding a narrow “live orphans” column only if needed.

**Micro-interaction that matters:** Tap a “Waiting on you” row → **focus that session and scroll the checklist item into view** (not “open phase” which still makes Sam hunt).

---

## 5. No `plan.md`

Don’t fake a ten-segment bar. Show **handoff + aggregate checklist + session activity** (what’s running, what’s blocked, last external note), plus a **“Run Kickoff” / “Add plan”** empty state. Sidebar ring stays indeterminate or “activity-only” until a plan exists. Treat it as an **inbox for the project**, not a roadmap cosplay.

---

**Where I expect other debaters to be wrong:** Treating the mockup’s polish (DnD, merge CTA, editable checks) as MVP. Sam’s pain is **triangulation across sessions**, not a prettier `plan.md`. Ship aggregation + staleness + deep links first; choreography second.
