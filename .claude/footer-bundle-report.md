# Footer bundle report (31 Oct 2026)

**The footer's right side is now Messages, Machines, More, Terminal. Everything in the brief is built, but only Codex reviewed it and browser checks ran in Chromium only.**

Commits: `4f9d5912` (the base) up to this report, on `lab/footer-bundle`. Not pushed to `mine`; `fork/update.sh` not run.

`origin/mine` has since gained `4bdde7e4` and `5a6028ed`. They touch none of the same files and a trial merge is clean, but this branch hasn't been tested with them.

## Checks

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean |
| Terminal position | Same x with each alert on, and all on, at 1300 and 900 wide (`footer-bundle.spec.ts`). The other chips' boxes and the Messages slot didn't move either |
| Named browser specs, final code | 52 pass, 2 fail (below) |
| Full browser suite, before the Codex fixes | 155 pass, 15 fail, 1 skipped. The same 15 fail on untouched `origin/mine` |
| Full vitest | 6625 pass, 10 fail, 13 skipped (below) |
| Screenshots | All tabs, More, Messages and the send bar, light and dark, opened and checked |

## Failures

| Test | Cause |
|---|---|
| `broadcast-bar.spec.ts:60`, Escape while sending | Also fails on `origin/mine`, so not from this work. Not fixed |
| `resource-pressure.spec.ts:5` | Timed out waiting for Settings while Codex ran alongside. Passes 3 of 3 alone |
| `agentAppMemory.test.ts` (1 test) | Also fails on `origin/mine`: `9:00 am` vs `9:00 AM` |
| `FilePaneNavigation.test.ts` (9 tests) | Failed only in the full run. All pass alone, so load is the likely cause |

## Review

| Reviewer | Result |
|---|---|
| Codex, high effort, whole diff | 2 low-severity bugs, both fixed with tests: Memory tab stuck on "Checking", popover reopening after Settings. Second pass: no defects |
| DeepSeek Flash, Grok 4.7 | **Did not run.** `second_opinion.py` needs macOS `sandbox-exec`, so these routes fail on Linux. Run them from the Mac before landing if you want those passes |

Codex's second pass came before the last commit, which only changes `app-view-tabs.spec.ts`.

DeepSeek wrote no code, for the same reason. I didn't call its CLI directly, because that sandbox is its only guard.

## Not verified

- WebKit: not run. Chromium used the installed build 1248 through a temporary config, because the pinned build isn't on this machine.
- The real Mac app: not run. `footer-bundle.spec.ts` uses the real footer with mocked native calls.
- `app-view-tabs.spec.ts`: updated for Machines, but it still fails earlier (hidden Inbox), as on `origin/mine`, so the edit hasn't run.

## Known limits

- A running terminal replaces the Terminal button with a chip of a different width, as it does today. It isn't an alert, so I left it.
- "Live game" means the games panel is open. A game hidden mid-play shows nothing on More, as Games showed nothing before.
- Being silent away from a saved place shows only in More's hover text. The dot is for problems (location off, or a location error).
- Messages reserves a fixed slot (166 px, or 96 px when narrow), so the space to its left stays empty when the chip is short.
- The Terminal button keeps its label when narrow, as it does today.
- `ringLabel` in `location.ts` is now used only by its test.

## Changes to check

- `data-fork-lab`, `-stacks` and `-memory` are now the tabs, present only while Machines is open. `data-fork-broadcast` is the row in the Messages popover. The chip hooks are `data-fork-machines` and `data-fork-more`.
- Specs changed on purpose: `lab-button`, `lab-health`, `footer-tidy`, `resource-pressure`, `app-view-tabs`, and the `broadcast-bar` and `lab-button` fixtures.
- With no memory report, high usage now shows on Machines rather than as its own "High usage" chip, so nothing can shift the footer.
- Beyond the brief: removed two existing divider lines (Stacks, Ring) and fixed Stacks' amber and red text, which was hard to read in light mode.
- `lab/table-games` and `lab/blob-health-dot` have nothing left to carry over: `table-games` is fully in `mine`, and `blob-health-dot`'s dot and hover text are carried onto the Machines chip.
