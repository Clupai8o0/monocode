# Recover desktop upgrades

Recover existing unfinished changes into the Tauri app, preserving newer behavior and original source worktrees/stashes.

## Implementation and checks

| Work | Source | Verification |
| --- | --- | --- |
| Cursor modes, permission IDs and model errors | Dirty Cursor worktree | ACP fixture regressions, context/compaction preservation, TypeScript |
| Transcript/model/effort performance | Saved commit `80000a41` | Fingerprint edits/truncation/eviction, model alias invalidation, effort/handoff suite |
| Poker recap removal and readable handoff banner | `748d250c`, `e4e7182b` | Table/browser and handoff tests |
| Session `/stage` | `upstream/feat/stage-command` | Command parser, session edit list, Plan/Orchestrator guards |
| Inline sign-in recovery | `upstream/feat/inline-provider-sign-in` | Authentication failure rendering, correct account, explicit retry |
| Per-Mono skills | `upstream/codex/mono-skills` | Owned/assigned/missing skills, path and hash protections, UI and CLI |
| Git watchers | `69d3ebcb` | Native/remote watcher lifecycle, scoped invalidation, polling fallback |
| Remove text-edit/HTML source size rejection | User screenshot | Local HTML over 8 MB and remote read/write regressions |
| Correct main Claude account routing | User-reported repeated false login error | Launcher account-isolation tests, actual main-account authentication and worker launch |

## Integration

1. Opus reviews recovered backend changes; Codex and Grok review the frontend and combined diff.
2. Resolve findings, integrate onto the current `mine`, then run the complete desktop suite, TypeScript and affected native/host checks.
3. Commit, push and stage the signed desktop build; verify its SHA matches the recovered commit.
4. Preserve shared handoff history and record remaining runtime checks.

Native-only feature ports, deliberately hidden features, mobile and the parked full IDE remain separate work.
