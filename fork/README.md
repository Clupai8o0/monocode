# Personal MonoCode fork

Fork of [hardbeat920/monocode](https://github.com/hardbeat920/monocode) (MIT). Own changes live on the `mine` branch.

| Piece | What it does |
|---|---|
| `fork/monocode` | The `monocode` command (symlinked from `~/.local/bin`). Swaps in a staged build if MonoCode is closed, opens it, starts `update.sh` in the background. |
| `fork/update.sh` | Merges `upstream/main` into `mine`, lets a Claude agent fix conflicts or a broken build, runs `tsc` + `npm test` + `tauri build`, stages the app. Rolls back on failure and sends a notification. |
| Hidden features | `src/fork/hiddenFeatures.ts`: Inbox, Notes and Automations are hidden (not deleted, so merges stay clean). The inbox stops polling and the automation scheduler stops. Off under `vitest` so upstream tests still pass. Set a flag to false to bring one back. The macOS View menu still lists Inbox and Notes; they do nothing. |
| PDF preview | `src/fork/pdf`: `.pdf` files open in a viewer in the file pane instead of the editor. pdf.js draws pages onto canvases, loaded only when a PDF is opened, so the app CSP stays unchanged. Zoom with the footer, Cmd+scroll, pinch or the zoom keys. No text selection or links yet. Browser test: `npx playwright test tests/browser/pdf-preview.spec.ts --project webkit`. |
| DeepSeek provider | `src/integrations/harness/providers/deepseek`: runs DeepSeek Harness (`dsh --profile acp`, standard ACP) as a MonoCode agent. Models and reasoning effort come from dsh. dsh sandboxes itself to the workspace and asks no edit approvals, so Supervised and Plan modes are not enforced by it. |

- State and log: `~/.local/state/monocode-fork/` (`update.log`, staged `MonoCode.app`, `built-sha`, `installed-sha`).
- Skips when the repo is not on `mine` or has uncommitted changes, so it never fights a session working here.
- Settings and sessions live in `~/Library/Application Support/com.monocode.desktop` and survive every swap.
- Keep fork features in their own files where possible; fewer conflicts with upstream.
- The built-in updater has no endpoint in source builds, so it never replaces this build with the official one.
