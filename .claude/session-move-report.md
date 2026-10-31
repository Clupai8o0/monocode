# Move a session: report for the Mac orchestrator

## Fixes from the Mac review (31 Oct, round 7)

**All 10 fixed, each with a test. Codex (high) found 3 more Highs in the fixes, all fixed. Its 2 Mediums are left open (listed below).**

| # | Fix | Test |
|---|---|---|
| 1 | A tab moved to this Mac always has an account: cx's id, or main's (`default`) | Model: `macAccountFor` |
| 2 | Past 500 records, only records that lock nothing are dropped (a tab that's gone). Locking records are never dropped. | Model: 501 records, the oldest stays |
| 3 | Undo throws if tmux can't list windows, and the journal stays | Host: timeout and "permission denied" keep every file |
| 4 | Rust searches every account home and takes the newest copy, history included | Rust: newer copy in `.claude-exec` |
| 5 | A repo counts as client work if its folder, real path or git folder is client work. Panoptic is still allowed. | Host and Rust: a link into `upwork/acme` is refused, a link into Panoptic passes |
| 6 | `start` refuses if a copy is already live. `confirm` only counts this move's worktree or window. | Host |
| 7 | Ownership is saved before `git worktree add`. Undo removes the worktree only if the branch tip still equals `manifest.head`. | Host and Rust: a branch with a new commit is kept |
| 8 | No signal unless the start stamp matches or the command line is Claude's. If it can't tell, it refuses. | Host: reused PID gets no signal |
| 9 | Mac git calls stop at a deadline (30 s, or 10 min for long steps), which kills git and whatever it started | Rust: a hanging git call gives up in under 5 s |
| 10 | Older cards take the new cwd, branch and left-behind list | Model |

**Codex's 3 Highs, fixed:**
- A crash before the add left the name open, so the next move could take it and the first move's undo would delete it. Now a move reserves the name by creating its folder, which only one move can do. Tests on host and Rust.
- tmux's "error connecting … (Permission denied)" counted as "no windows". Now only a missing server or socket counts as no windows.
- A repeated `start` could open a second window before the first one registered. Now it returns the window that is already running or queued.

**Left open (Codex Medium):**
- An unstamped PID reused by, say, `vim ~/.local/bin/claude-acct` would pass the command-line check. A tighter check would look at the executable itself.
- If git exits but a helper it started keeps the output pipes open, the Rust reader can still wait past the deadline. The deadline only covers git running.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, web and host | Clean |
| Vitest `src/fork` | 964 passed |
| Vitest host (`session-move`, `server`, `external-sessions`) | 75 passed, 2 skipped (interop, run on its own) |
| Rust module, scratch crate | 18 passed, 2 ignored. `rustfmt` clean. |
| Packs, Rust to TypeScript and back | Pass |

The app's Rust build is still unchecked here, as in earlier rounds. `git_within` uses `libc` and `process_group`, so run `cargo check --lib` on the Mac. DeepSeek and Grok didn't run, because they can't run on this machine.

---

## Fixes from the Mac review (31 Oct, round 6)

**All five fixed with a test each, plus a Try again button. Codex (high) reviewed the fixes: 2 more found and fixed, then no defects.**

Commits: `8d0533fc`, the follow-up, and this report, on top of the Mac's `07a6b47f`.

| Sev | Problem | Fix | Test |
|---|---|---|---|
| High | Undo left the new Mac tab open on the conversation | Undo closes the tab first, and deletes its saved record so history can't reopen it. The tab can't take a turn until the move finishes. | Runner: close runs after the failed card, before `undo` |
| High | Journal writes failed silently | A move that can't save its journal fails before stopping the source | Runner: no stop, no pack |
| Medium | Crash between card and journal clear undid a finished move | Each card records its move id; recovery sees a saved card and only cleans up. A failed clear no longer rolls back. | Model and runner |
| Medium | Host, Mac, host locked the next move to the Mac | Landing on a host again drops the old `lab:<id>` record | Model |
| Medium | A lost poll reply rolled back a finished step | The host keeps finished answers until the move's next step, its `done`, or an hour | Host: same answer twice, then gone after `done` |

**Codex's two extra findings, both fixed:**
- A finished move's leftover journal is dropped before a later move replaces its card. Otherwise the next launch would undo it.
- The undone tab is deleted through the app's own delete path, not just closed.

**Retry without a restart:** a move that stayed stopped now shows "Try again" in its line. It runs the same undo as the app launch does, and the line can't be dismissed while the move is stuck.

A move to this Mac now saves the new tab's id in its journal, so recovery after a crash closes that tab too.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, web and host | Clean |
| Vitest `src/fork` | 962 passed |
| Vitest host (`session-move`, `server`, `external-sessions`) | 69 passed, 2 skipped (interop, as before) |
| `tests/browser/session-move.spec.ts`, Chromium, light and dark | 2 passed. I opened both screenshots; the Try again line is in them. |
| Rust | Not touched this round |

**Only in tests, never in the real app:** the tab's close and delete (`closeMovedTab` in `App.tsx`), the Try again button inside a real stuck move, and recovery closing a tab after a restart. Watch these on the Mac:
1. Make a move to this Mac fail after the tab opens (stop Vivobook's host mid-move). The tab should close, and should not come back in history.
2. Make a rollback fail (Vivobook offline), then bring it back and press Try again. The line should clear and the session should take turns.
3. Move host, Mac, host, then Mac again. The last move should start.

---

## Earlier report (round 5)

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
