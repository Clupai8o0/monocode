I'll read the mockup and the existing project surfaces so the debate is about this product, not a generic dashboard.The page is a status board for the person who is the bottleneck. The mock builds a planner.

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
