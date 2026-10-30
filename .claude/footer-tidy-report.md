# Footer tidy report, for monocode-68

All 6 steps are built and pushed on `lab/footer-tidy`, ready for your review. The red 16 on the Mac is still unmeasured.
Range: `ae2d5cbc..a850bc51` (7 commits on `origin/mine` 7fb1b8f9), plus the commit that adds this report.
The relay could not reach monocode-68 ("No agent named 'monocode-68' is reachable"), so this file is the report.

## Checks

| Check | Result |
|---|---|
| `tsc` | Clean on `a850bc51` |
| Vitest, full | 6625 passed, 1 failed, 13 skipped; last run one commit before `a850bc51` |
| Vitest after `a850bc51` | `messageLog` and `broadcast` only: 53/53 |
| Playwright, chromium | 23/23, one commit before `a850bc51`; WebKit not run |

- The 1 failure is `src/features/agent-app/model/agentAppMemory.test.ts` ("9:00 am" vs "9:00 AM"). It looks like a locale difference on this machine; the file isn't in my diff, but I did not run it on a clean `origin/mine`.
- `FilePaneNavigation` failed in one full run while load was high, then passed alone (9/9) and in the next full run. Treat it as flaky.
- Playwright used a throwaway config, not committed: port 1435 was taken and the pinned browser build is missing, so it ran on port 1447 with the installed build 1248.

## Reviews

- Codex at high, twice. It wasn't out of quota. 4 medium findings, all fixed. The last 2 fixes went in after the second pass, so `a850bc51` has had no Codex pass.
- DeepSeek and Grok did not run. `second_opinion.py` refused them because `model-policy.json` treats this repo as confidential (Codex only). I did not bypass that. If you want them, the policy has to change.

## Step 4: is the 16 real?

Not measured: I have no SSH access to the Mac, so please check it there. On Vivobook's real log (7 days, 12 rows) there were 2 problems, both real failed sends at the time. One was a gone socket (ENOENT), which the new rule no longer counts.

False alarms fixed in the model, with tests:

| Case | Now |
|---|---|
| Target session has ended | Not a problem |
| Target is busy | "will see it after this turn", not a problem |
| Send failed because the socket is gone | Settled, not a problem |
| Failed send, same text resent within 30 minutes | Settled, and the row says so |
| Busy session reads it more than 10 minutes late | Pairs (window raised to 1 hour) |

The "other account" case from the brief doesn't occur: the readers read `.claude`, `.claude-exec` and `.claude-cx`, and a session in any other folder doesn't resolve to a target, so it never counted as a problem.

Also found and fixed in the UI:

- Problem rows only said "Failed"; they now show the reason.
- The problems row opens on 1h so the list matches the count, and "Open messages view" goes back to 24h. That overrides any window chosen earlier.

Known limit: resend matching compares the 160-character key and 600-character preview. Two different messages sharing their first 600 characters could still settle wrongly. A full fingerprint would mean changing both readers.

## Added beyond the brief

- Sam's request via monocode-20: Send to all has a third scope, "One project", with a project picker. Logic and tests are in `broadcastModel.ts`.
- monocode-blob-health's Lab health dot (`d8bba6dd`) is cherry-picked as `627c9a15`, at its request, because it won't be watching. Drop that commit if you'd rather land it separately.
- Send to all also leaves out blank tabs that have no conversation yet, so it can't start one.
- The lab "New session" button opens the dialog on that host, via a small marked edit to `connections.ts` and `AddRemoteProjectDialog`.

## For you to check

- The lab count uses `liveSessions`, so idle sessions count as "running": a chip can say "4 running" with one idle. I followed the brief; change it if Sam wants only working sessions counted.
- The count misses sessions MonoCode itself runs on the host, because the host's list excludes them. A session started from "New session on Vivobook" may not raise the number. Not fixed; it needs App wiring.
- Remote sessions in Send to all: a busy one, or one the app has no connection to, stays unticked with the reason shown.
- The real send path was not exercised in the running app, only through a browser harness and unit tests.
- `ALL_PROJECTS` and `liveSessions` landed on `mine` meanwhile, so I use those. I also added `useRemoteSessions` to the same store. `App.tsx` has one import and one listener for Send to all.

Nothing skipped from the brief. Moving a running session to the lab was not built, as instructed.
