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
