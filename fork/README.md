# Personal MonoCode fork

Fork of [hardbeat920/monocode](https://github.com/hardbeat920/monocode) (MIT). Own changes live on the `mine` branch.

| Piece | What it does |
|---|---|
| `fork/monocode` | The `monocode` command (symlinked from `~/.local/bin`). Swaps in a staged build if MonoCode is closed, opens it, starts `update.sh` in the background. |
| `fork/update.sh` | Merges `upstream/main` into `mine`, lets a Claude agent fix conflicts or a broken build, runs `tsc` + `npm test` + `tauri build`, stages the app. Rolls back on failure and sends a notification. |

- State and log: `~/.local/state/monocode-fork/` (`update.log`, staged `MonoCode.app`, `built-sha`, `installed-sha`).
- Skips when the repo is not on `mine` or has uncommitted changes, so it never fights a session working here.
- Settings and sessions live in `~/Library/Application Support/com.monocode.desktop` and survive every swap.
- Keep fork features in their own files where possible; fewer conflicts with upstream.
- The built-in updater has no endpoint in source builds, so it never replaces this build with the official one.
