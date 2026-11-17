**D1** — Verdict: needs-you count on the sidebar row; no segmented bar, no "3 of 10"; a ring survives only if it encodes unmet asks, never completion.
Reason: bar and ring both render inferred completion — the least trustworthy number on the page — while the count is a fact. (Changed: I defended the ring.)

**D2** — Verdict: display-only on home; agents write check state through a tool; Sam ticks the checklist he already ticks in chat.
Reason: done-when is the definition of done (B, C), but a second editable copy is a second job — two human-step lists diverge by tomorrow (A).

**D3** — Verdict: keep the Status column as a fixed enum with provenance, written only through the tool by a person or trusted agent; signals suggest, never set.
Reason: merged ≠ done (B, A); Yap Phase 1 is the counterexample already on the board. (Changed: I had merge-to-default compute Done. Git cannot see journaling on a phone.)

**D4** — Verdict: keep "Phase N · name" plus needs pill; kill the mini bar.
Reason: one token in a chat — where am I, does it need me (B); ten pixels of progress is the cut bar's corpse.

**D5** — Verdict: one tap lands in that chat with the item scrolled into view and the approve control focused.
Reason: C is right that the phone bottleneck is action, not reading — but an approval without the transcript in front of him is how he approves the wrong thing.

**D6** — Verdict: ship brief-only "Start phase"; no branch naming.
Reason: auto-worktree already names branches; a pre-built `step-N-slug` manufactures the stale mapping this page exists to delete (B).

**D7** — Verdict: expand every phase with a live chat or open ask; collapse the rest.
Reason: A's three stuck phases — a single "current" hides precisely the ones waiting on him.

**D8** — Verdict: both, split: one project handoff line at the top, newest note quoted under its phase with its age.
Reason: they answer different questions ("where are we" vs "what happened here"), and the quote is the only status prose that ages honestly. (Changed: I wanted a top strip only.)

**D9** — Verdict: a wait outlives its session; all four missed it.
Reason: an ask whose session died still sits in the queue, and a resolve that doesn't notify the asking agent is Sam replying into a void. Flag liveness on the row, order by blocked-longest, wake the agent on resolve.

**Weakest argument:** C's #2, "agent-authored narrative status beats synthetic flags." It reinstates exactly the stale prose the page exists to kill — a status you can neither machine-read nor date is a rumour, not a state.
