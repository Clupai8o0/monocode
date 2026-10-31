# Move a session: report for the Mac orchestrator

**Built and pushed, but never run end to end. The app can't be built on Vivobook, so the first real move is yours.**

Commits: `4f9d5912..` this report, on `lab/session-move`. 2 commits behind `origin/mine` (HTML preview, Add to chat); a trial merge has no conflicts.

## What exists

| Direction | Where the button is | Ends as |
|---|---|---|
| Mac tab to lab host | Session menu, "Move to Vivobook" (the host's name) | Read-only card; the session runs through `lab-session` |
| Lab session to Mac | Its viewer, "Move to this Mac" | New tab in a new worktree on the Mac |

Rollback, the cards surviving a restart, the client rule on both ends and `session.move.v1` are all in.

## Not built, or different from the brief

- **No button on remote-project tabs or `vivobook` harness tabs.** Only lab sessions opened in the viewer move back. This is a gap against "on a lab session"; your call whether it matters.
- **A lab session has no card after moving back.** It has no tab on the Mac to hold one. An older card for that conversation now points to the new tab.
- **Staged changes arrive unstaged.** File contents match byte for byte.
- **The new Mac tab shows only the last page of text turns (60 at most, no tool calls).** Claude itself has the whole transcript.
- **"Came up" on the Mac only means the transcript is in place.** Claude resumes on the tab's first turn.
- **The Mac has no room check for accounts.** The tab stays on its own account's role, or the default if that role isn't set up.
- **A lab session stopped by a move can leave its window open for up to 1 hour.** `lab-session` holds a window open after a non-zero exit, and a restart then takes the name `<name>-2`.
- **`git worktree add` runs without hooks.** A failing hook would leave a worktree the move can't tell is its own.
- **A move whose target can't be cleaned up stays stopped.** It only retries at the next app launch, and there's no retry button.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit`, web and host | Clean |
| Vitest `src/fork` | 917 passed |
| Vitest host (`session-move`, `server`, `external-sessions`) | 68 passed, 2 skipped (the skipped pair is the interop below) |
| Rust module tests | 13 passed, 2 ignored (interop), **in a scratch crate only** |
| Packs across Rust and TypeScript, both ways | Pass; files identical |
| `tests/browser/session-move.spec.ts`, light and dark, Chromium | 2 passed; I opened both screenshots |
| `close-session` and `machine-sessions` specs | 2 pass, 2 fail; **the same 2 fail on the base commit** |

WebKit was not run. The interop and browser specs last ran before the final small fixes, and the browser spec ran again after them.

## Rust: not compiled as part of the app

`cargo check --lib` and `cargo test --lib fork_` **can't run here**: `libdbus-sys` needs `dbus-devel`, and I have no root. I compiled `fork_session_move.rs` alone with the Tauri command removed. So these have **never been compiled**, on Linux or macOS:

- the `fork_session_move` command wrapper
- the `lib.rs` registration
- the `remote.rs` allowlist line
- `provider_home` becoming `pub(crate)`

## Review

| Reviewer | Result |
|---|---|
| Codex, high effort, whole diff | 5 passes, 21 findings, all fixed. One was a blocker: `sessionMove` was missing from the Rust allowlist, so every host move would have failed. |
| Codex on the last 3 fixes | **Not re-reviewed** (saving the card, compaction lock, worktree hooks) |
| DeepSeek Flash, Grok 4.7 | **Did not run.** `second_opinion.py` needs macOS `sandbox-exec` and `security`. Please run both from the Mac. |

Each Codex pass still found something new, so expect more in the recovery paths.

DeepSeek wrote none of this for the same reason. I wrote the Rust port myself rather than run its CLI outside the sandbox.

## Real, and fakes only

**Real on this machine:**
- git and file work with two fake home folders: dirty tree, deleted file, binary, empty file, link, local-only commit
- `claude -p --resume` from a different folder: same session id, and it remembered the earlier turn
- A queued start through the real `lab-session`, which `confirm`'s check should read as queued. I saw the gate's output by hand; the automated check ran against a fake gate.
- Two live lab sessions started with `claude --resume X` are registered under id `X`, which is what the "came up" check relies on

**Fakes or never run:**
- **Interactive resume through `lab-session`:** it waited about 10 minutes behind a full gate (10 of 10) and never started
- **Faked in tests:** `lab-session`, `agent-gate`, `claude-acct`, process signals
- **Never run:** the App wiring (menu item, send lock, `openMovedTab`, `publishOwnSessions`), the `tmux` steps in undo, the request path to a real host, recovery after an app restart, and the sidebar's "Moved" tag

## First real move: what to watch

Update Vivobook's host first, or the button says "Update Vivobook to move sessions".

1. Run `cargo check --lib` and `cargo test --lib fork_` on the Mac before anything else.
2. **Mac to Vivobook, on a scratch session with a dirty tree.** Watch that the progress line advances and Cancel disappears at the stop. Then run `diff -r` on the two worktrees.
3. **The new lab session.** It should show in `lab-session list` and `ListAgents`, resume the real conversation, and be counted once in the Home lab count.
4. **The card.** It should name the ignored files, open the live session, and survive an app restart. Send to all should skip the tab, and the composer should be gone.
5. **Failure.** Stop the tmux session or fill the gate during a move. Vivobook should end with no `moved-*` worktree or branch, and the tab should take a turn again.
6. **Back to the Mac.** The tab should resume on the first turn with full memory, on the right account. The old card should now open that tab.
7. **Client refusal.** A project under `upwork/` other than Panoptic should have no button.
8. **Close the app mid-move.** On reopening, it should undo the move and say so.
9. **A move while the gate is full.** It should say it's waiting in line, and give up after 15 minutes with a rollback.

Guardrails: the Rust build must pass on macOS, and only one machine deploys at a time, which doesn't apply here because nothing was deployed.
