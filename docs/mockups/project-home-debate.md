# Project home: what the model debate decided (8 Nov 2026)

**Answer:** the home is a "what needs me" page with a plain roadmap under it, not a progress dashboard. Mockup v2: `project-home.html`.

Debaters: Grok 4.7, DeepSeek Flash, Gemini 3.8 Flash and Cursor Composer 2.5, each answering on its own, then ruling on each other's answers (both Codex logins were out of quota). Transcripts: `debate/`.

## Rulings

| # | Question | Ruling | Agreed |
|---|---|---|---|
| D1 | How to show progress | Amber "needs you" count on the sidebar row; plain "3 of 10 done" text on the home. No bar, no ring | 4 of 4 (DeepSeek: no "3 of 10" either) |
| D2 | Done-when checks | Display only; chats tick them through a tool; your own steps stay on the checklist | 4 of 4 |
| D3 | Who sets phase status | A fixed list (Not started, In progress, Built, Blocked, Done) set by you or a trusted chat, with "set by, when". Git only suggests | 4 of 4 (Cursor: keep it out of plan.md) |
| D4 | Strip above a chat | "Yap › Phase 2 · Full Markdown" plus a Needs you pill; click for the roadmap | 4 of 4 |
| D5 | Tapping a wait | Opens that chat, scrolls to the item, puts the cursor in the reply box | 4 of 4 |
| D6 | Start phase | Opens a chat with the phase brief and done-when; no branch naming | 4 of 4 |
| D7 | Which phases are open | Every phase with a live chat or a wait; the rest are one line | 4 of 4 |
| D8 | Handoff | One handoff line at the top, plus the newest chat note under each open phase | 4 of 4 |
| D9 | What everyone missed | An "All projects" page: every wait across projects, oldest first | Cursor, Grok; DeepSeek: say when a wait's chat has ended; Gemini: spend today |

## Cut from v1

- Segmented progress bar and its legend
- Drag-to-link and the "not linked" tray (now one "Chats not on a phase" line with a menu)
- "Live now" column, celebrations, J/K keys
- Merge-and-mark-done button and `step-N-slug` branches

## Not built yet

- Gemini's "pause every chat" panic button (left out: easy to hit by mistake).
