# Debate round 2: rule on the disputes

Same brief as round 1 (MonoCode per-project dashboard; mockup at docs/mockups/project-home.html). Below are the four round-1 answers, anonymised as Model A-D. One of them is yours. Now argue.

Rules: max 450 words. For each dispute give a verdict (one line) and the reason (one line). Change your mind where another model's argument is better, and say so. Name the single weakest argument in the other answers.

## Disputes
D1. Progress visual: keep a segmented bar / "3 of 10" on the home page, sidebar ring per project, needs-you count on the sidebar row, or some combination?
D2. Done-when criteria: tickable by Sam on the dashboard, maintained only by agents through a tool, or display-only text?
D3. Who sets phase status: agents write the plan.md Status cell through a tool (with a fixed enum), MonoCode computes it from a priority stack of live signals, or a person/trusted agent marks it and live signals only suggest? Is plan.md Status column kept at all?
D4. Chat strip (layout B): keep with mini bar, keep as "Phase N · name + needs pill" only, or drop for v1?
D5. Tapping a "Waiting on you" item: resolve it inline on the dashboard, or jump into the chat with the item in view?
D6. "Start phase": opens a chat with the phase brief (no branch naming), or not in v1?
D7. Which phases are expanded: only the current one, or every phase with a live chat or an open ask?
D8. Handoff: quote the newest handoff/status-note line under each phase, one handoff strip at the top, or both?
D9. Anything ALL four missed that Sam needs?

## Model A

## Must

1. The existing project row shows the wait count and which phase it sits on. Sam loses projects from the rail. A home he must open per project repeats that failure.
2. "Waiting on you" is every open checklist item and approval wait in the project, and each row opens that chat on the item. On the phone, this list is the product.
3. Every phase with a live session or an open ask is expanded at once. Yap has three. A single "current phase" hides the two that are stuck on him.
4. `docs/plan.md` is read for phase, what, and done-when. Finished phases are one quiet line.
5. The agent links a session to a phase the way it already posts checklist items. Sam can override with a drag. That link is the only join.
6. Under each open phase, quote the newest handoff line and its age. That sentence is the status prose, and it stays a sentence.
7. Sam marks a phase done. An agent may propose it. A merged branch may suggest it. Nothing else flips it.
8. The phone workspace gets the same wait list and the same quotes. A desktop-only home ignores how he checks in.

## Cut

The segmented bar, the legend, and "3 of 10 done." Phases are not equal, and the number celebrates the finished prefix while the real work is stuck in the middle.

"Built, not merged" as a phase color. Source control already shows commits. Phase 1 is unfinished because he has not journaled, which no merge state can see.

"Start phase" creating `step-N-slug`. Auto-worktree already names branches. Opening a chat with the phase brief is enough. The branch ceremony fights that feature in week one.

The Live now column and the unlinked tray. The sidebar already lists those chats. Most chats are not phases, and a tray turns that into homework.

Ticking done-when on the home page. "You like the feel" is not a checkbox. A real human step goes on the checklist. Two lists of human steps diverge by tomorrow.

The mini bar under every chat tab, plus undo toasts and J/K. In a chat he needs one token: the phase name, and whether it is waiting on him.

## Data

`docs/plan.md` stays the plan and loses authority over status. Agents already write stale prose into that column. Parsing it into an enum will be confidently wrong.

MonoCode stores and syncs `{session id, phase id}`. Two live facts come from systems that already exist. Needs-you means an open checklist item or an approval on a linked session. In progress means a linked session is live and not waiting. Done means a person, or an agent he trusts, said so.

Branch matching does not survive this app. Worktree branches are not `step-3-find-it-later`. Squash merges delete the branch when the work lands. One session covers a slice of a phase, or two. The Mac and the phone see different live sets. A session on the convention branch can be doing unrelated cleanup. "Branch merged" is a suggestion chip. It leaves the phase status alone.

Handoffs and claims notes stay evidence. Quote the latest handoff. Do not mine them for state.

## Layout

One column: waits, then every open phase with its quote and its chats, then everything else collapsed. The sidebar is the other column. The interaction that matters is tapping a wait and landing in that chat with the reply ready, on the phone and the desktop.

## No plan.md

Show the sessions, the waits, and the handoff lines, grouped by session. One action may draft a plan table from those lines. Until that file exists there is no bar, no phases, and no start button.

## Model B
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

## Model C
### 1. MUST Features (max 8)
1. **Aggregated "Waiting on You" action queue**: Surfaces blocking human approvals and device tests across all project sessions in one place—Sam's primary phone bottleneck.
2. **Phase list with agent-authored narrative status**: "Built, waiting on phone journal" beats synthetic flags every time; rich context is why Sam tracks projects.
3. **Explicit session-to-phase tagging**: Let agents declare their phase via tool or session metadata; heuristic branch-name matching (`step-N-*`) breaks on hotfixes and worktrees.
4. **One-tap "Start Phase" chat launcher**: Spawns an agent chat pre-seeded with the phase brief and done-when criteria from [plan.md](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/docs/mockups/project-home.html).
5. **Sub-chat roadmap breadcrumb strip (Layout B)**: Anchors context within deep agent chats so Sam always knows which milestone is burning tokens.
6. **Mobile-first remote action execution**: Blockers must be actionable (approve, retry, tick verified) directly from the card without forcing open desktop terminals.
7. **Active worktree / unmerged branch diff pulse**: Highlights dirty worktrees and unmerged commits per phase to prevent duplicate agent runs.
8. **Interactive "Done-when" check toggles**: Allows Sam or agents to check off acceptance criteria, surfacing a clean "Merge & mark done" prompt.

### 2. CUT: Wrong, Overbuilt, or Noise
- **Drag-and-drop session tray**: Pure desktop vanity. Sam runs 15 sessions and checks from his phone; nobody drags HTML chips on mobile. Auto-bucket unlinked sessions under "Ad-hoc / Maintenance".
- **Undo toasts for git/agent actions**: Launching a session or merging branches isn't an in-memory toggle. Fake undo buttons create dangerous illusions of safety for non-reversible AI actions.
- **Vim J/K navigation and celebratory glow animations**: Confetti rings and keyboard traps belong in consumer toy apps, not a high-throughput multi-agent cockpit.
- **Brittle git-heuristic status derivation**: Inferring phase progress from branch names is a fragile shortcut that collapses under real-world git workflows.

### 3. Data Model: Where It Lives & Why Pure Derivation Fails
The roadmap must live in `docs/plan.md` in the repo. If status is trapped in Tauri local storage or SQLite, external tools (Claude Code, Cursor, Codex) cannot read or update it.

**Why deriving status from git branches fails**: Git branches are messy, rebased, squashed, and abandoned. An unmerged branch doesn't mean "Built, not merged"—it might be broken junk. An active session on `step-3` might just be fixing a typo. Furthermore, git can't infer human blockers like "waiting on you to journal on your phone."

**How it stays true without Sam typing**:
- **Repo-level ground truth**: `docs/plan.md` holds the phases, criteria, and human-readable status notes. Give agents a dedicated tool (`update_phase_status`) or convention to update this file when their goal finishes.
- **Live telemetry overlay**: MonoCode dynamically overlays ephemeral process states ([`LiveAgent`](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/src/fork/projectStatus/ProjectAgentStatus.tsx), pending approval prompts, and [claims.py](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/src-tauri/src/fork_claims.rs) file locks) on top of the markdown plan without touching git.

### 4. Layout & Micro-interaction
- **Layout**: A single vertical stream—critical blockers pinned at the top, sequential phase accordion in the center, and live session health in a collapsible side rail (or bottom sheet on mobile).
- **Single micro-interaction**: Tapping an amber "Waiting on you" pill immediately resolves the prompt or marks a test verified, unblocking the agent without opening the chat transcript.

### 5. Projects Without a `plan.md`
Degrade gracefully into an **Operational Pulse** rather than showing an empty state or nagging modal:
1. **Live Sessions & Claims**: Which agents are running and which files they own via [claims.py](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/src-tauri/src/fork_claims.rs).
2. **Latest Handoff**: Renders [.claude/handoff.md](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/.claude/handoff.md) (what finished, what is left).
3. **Pending Checklists**: Aggregated items from [ChecklistSidebar](file:///Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-introduce-a-global-level-dashboa-f80d62/src/fork/checklist/ChecklistSidebar.tsx).
4. **Git Activity**: Dirty worktrees and recent branch commits.
5. A one-click CTA: *"Draft plan.md with an agent"*.

## Model D


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

