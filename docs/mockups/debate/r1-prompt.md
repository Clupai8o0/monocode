# Debate round 1: a per-project dashboard for MonoCode

You are one of several AI models debating a product design. Be opinionated. Disagree where you think others will be wrong. No code. Max ~600 words.

## Context
MonoCode is a desktop app (Tauri + React, repo = current dir) that runs many AI coding sessions (Claude Code, Codex, Grok, Cursor...) side by side, grouped by project. One person (Sam) runs 5-15 sessions at once across several projects, often checks in from a phone, and loses track of where each project stands.
Existing features worth reusing (see src/features and src/fork): project sidebar with live agent badges (src/fork/projectStatus), per-session checklist sidebar fed by a "checklist" tool agents call for steps the human must do (src/fork/checklist), "Monos" (named agent setups) with an overview + contribution calendar (src/features/monos/ui/MonoOverview.tsx), handoff notes (.claude/handoff.md), file claims + status notes per session (claims.py), automations, inbox, notifications, usage/cost, source control, artifacts, session archive.

Sam's ask: "a global level dashboard per project, or checklist or something". Example: his app Yap has a roadmap table in docs/plan.md with columns Phase | What | Done when | Status (10 phases: 0.0 Mockups ... 7 Public launch). Status today is hand-written by agents ("Built, not merged; waiting on you journalling on it", "In progress in another session", "Other session's phone test passed; not committed as of its last note").

## Current proposal (mockup at docs/mockups/project-home.html — read it)
A) Project Home page (opens when you click a project): segmented progress bar (one segment per phase), "Waiting on you" list aggregated from checklist items across the project's sessions, roadmap list (done phases compact, current phase expanded with Done-when checks, linked chat chips with live dots, Start phase button that opens a chat with the phase brief on branch step-N-slug), "Live now" chats, a tray of chats not linked to a phase (drag to link), undo toasts.
B) A thin strip under each chat tab: "Yap › Phase 3 · Find it later" + mini progress bar, click → roadmap popover.
Status is derived: live session on phase branch → In progress; open checklist item → Needs you; branch merged → Done; commits unmerged → Built, not merged. Stale notes show "as of 2d ago".

## Answer
1. MUST features (max 8), each one line + why. Include anything the proposal is missing.
2. CUT: what in the proposal is wrong, overbuilt or noise. Be blunt.
3. Data model: where roadmap + status should live and how it stays true without Sam typing. Attack the "derive status from branches/sessions" idea if it's fragile.
4. Layout: one sentence on the best overall layout, and the single most important micro-interaction.
5. Projects without a plan.md: what does the dashboard show?
