# Cursor + Claude Deep Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen Cursor toward Claude’s product depth (context, background wait, compact when available, limits/handoff, MCP health) while improving Claude day-to-day, under one coordinated design on this branch.

**Architecture:** Shared harness events (`context`, `background.updated`, `usage.limited`, `compactContext`); providers fill what their CLI/ACP can emit. Four parallel streams (A–D) with explicit shared-file owners. No fake meters or hollow compact if unsupported.

**Tech Stack:** TypeScript/React (Vitest), Tauri/Rust MCP commands, Cursor Agent ACP (`session/update` `usage_update`, `/compact` prompt), existing continue-elsewhere + extraUsage.

**Spec:** `docs/superpowers/specs/2026-11-03-cursor-claude-deep-integration-design.md`

---

## File map

| File | Responsibility | Stream |
|------|----------------|--------|
| `src/integrations/harness/providers/cursor/cursor.ts` | Emit `context` / `background.updated`; compact; advertise ACP compaction | **A** |
| `src/integrations/harness/providers/cursor/cursorAdapter.ts` | Register `compactContext` when implemented | **A** |
| `src/integrations/harness/providers/cursor/cursorLive.test.ts` | Live ACP fixture tests for A | **A** |
| `src/fork/continueElsewhere/*`, `src/fork/usage/*`, `usageLimit.ts`, `apply.ts` (cursor reset), `CursorUsage.tsx`, footer/sidebar wiring | Limits + handoff (mostly already on branch) | **B** |
| `src-tauri/src/harness.rs`, `lib.rs` | `cursor_mcp_list` command | **C** |
| `src/features/settings/model/mcp.ts`, `mcpSettingsCache.ts` | Parse + load Cursor MCP health | **C** |
| `src/features/sessions/ui/Composer.tsx`, `mcpPicker.ts` | Request Cursor health when harness is cursor | **C** |
| `src/fork/statusline/StatusExtras.tsx` | Do not attach Claude rate limits to Cursor sessions | **C** |
| `src/fork/usage/claudeStreamUsage.ts` (+ tests), `claudeProtocol.ts` as needed | Claude stream-usage / rejected-window polish | **D** |

### Shared-contract owners (merge order)

1. **B first to commit** — already largely implemented; land usage/continue/footer so A/C/D build on green limits.
2. **`apply.ts` / `types.ts`** — B owns cursor `usageLimitFromError` reset wiring already present; A must not regress `context` / `background.updated` apply paths (tests already exist).
3. **`cursor.ts`** — **A only** after B commit; C/D do not edit.
4. **`claude.ts` / `claudeStreamUsage.ts`** — **D only**.
5. **MCP/settings/composer/statusline** — **C only**.

### Parallelism

After Task 1 (B commit), Tasks 2–4 (A), 5–7 (C), and 8–9 (D) may run as parallel subagents. Task 10 is the integration gate.

---

### Task 1: Land Stream B (limits & handoff) already on the branch

**Files:**
- Existing uncommitted: `continueElsewhere.ts`, `continueUsage.ts`, `ContinueElsewhereUi.tsx`, `extraUsage.ts`, `CursorUsage.tsx`, `UsageFooter.tsx`, `Sidebar.tsx`, `App.tsx`, `apply.ts`, `usageLimit.ts`, `fork_extra_usage.rs`, tests

- [ ] **Step 1: Verify B tests**

Run:

```bash
cd /Users/clupa/Documents/projects/monocode-worktrees/mc-can-you-continue-improving-the-code-revi-4646c8
npx vitest run src/fork/continueElsewhere/continueElsewhere.test.ts src/fork/usage/extraUsage.test.ts src/features/sessions/model/usageLimit.test.ts src/fork/usage/AllUsage.test.ts
```

Expected: all pass.

- [ ] **Step 2: Confirm product invariants in code (read-only check)**

Confirm these already hold (fix only if missing):

- `CONTINUE_POOL` includes `claude`, `codex`, `cursor`
- `harnessUsedPercent("cursor")` uses hotter of Auto/API bars
- `usageLimitFromError` + `cursorUsageResetsAt()` on Cursor `session.error` in `apply.ts`
- Footer renders `<CursorUsage />` when `session?.harness === "cursor"`

- [ ] **Step 3: Commit Stream B**

```bash
git add \
  src/fork/continueElsewhere/continueElsewhere.ts \
  src/fork/continueElsewhere/continueElsewhere.test.ts \
  src/fork/continueElsewhere/continueUsage.ts \
  src/fork/continueElsewhere/ContinueElsewhereUi.tsx \
  src/fork/usage/extraUsage.ts \
  src/fork/usage/extraUsage.test.ts \
  src/fork/usage/AllUsage.tsx \
  src/fork/usage/AllUsage.test.ts \
  src/fork/usage/CursorUsage.tsx \
  src/app/shell/UsageFooter.tsx \
  src/app/shell/Sidebar.tsx \
  src/app/App.tsx \
  src/integrations/harness/core/apply.ts \
  src/features/sessions/model/usageLimit.ts \
  src/features/sessions/model/usageLimit.test.ts \
  src-tauri/src/fork_extra_usage.rs \
  src-tauri/src/lib.rs
# Include any other files that are strictly part of Cursor usage / continue-elsewhere.
git commit -m "$(cat <<'EOF'
Add Cursor usage meters and usage-aware continue-elsewhere.

EOF
)"
```

Do **not** commit unrelated efficiency edits in the same commit unless they are required for B to compile.

---

### Task 2: Cursor emits `context` from ACP `usage_update` (Stream A)

**Files:**
- Modify: `src/integrations/harness/providers/cursor/cursor.ts`
- Test: `src/integrations/harness/providers/cursor/cursorLive.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `cursorLive.test.ts` inside a new `describe("cursor context usage", () => { ... })`:

```typescript
it("emits context from ACP usage_update", async () => {
  const { events, promptId, turn } = await startTurn("cursor-context");
  notify("session/update", {
    sessionId: "cursor_1",
    update: {
      sessionUpdate: "usage_update",
      used: 53_000,
      size: 200_000,
    },
  });
  expect(events.some((e) => e.type === "context")).toBe(true);
  expect(events.find((e) => e.type === "context")).toMatchObject({
    type: "context",
    used: 53_000,
    window: 200_000,
  });
  reply(promptId, { stopReason: "end_turn" });
  await turn;
});

it("ignores usage_update without numeric used/size", async () => {
  const { events, promptId, turn } = await startTurn("cursor-context-empty");
  notify("session/update", {
    sessionId: "cursor_1",
    update: { sessionUpdate: "usage_update" },
  });
  expect(events.some((e) => e.type === "context")).toBe(false);
  reply(promptId, { stopReason: "end_turn" });
  await turn;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "emits context from ACP usage_update"
```

Expected: FAIL (no `context` event).

- [ ] **Step 3: Implement minimal handling in `handleSessionUpdate`**

Near the top of `handleSessionUpdate` in `cursor.ts`, after resolving `kind`, add (reuse existing `numberField` / `asRecord` helpers already in the file):

```typescript
if (kind === "usage_update") {
  const used =
    numberField(update, "used") ??
    numberField(update, "usedTokens") ??
    numberField(update, "used_tokens");
  const window =
    numberField(update, "size") ??
    numberField(update, "window") ??
    numberField(update, "contextWindow") ??
    numberField(update, "context_window");
  if (used != null || window != null) {
    emit({
      type: "context",
      ...(used != null ? { used } : {}),
      ...(window != null ? { window } : {}),
    });
  }
  return;
}
```

Do not invent percentages when both are missing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "cursor context usage"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/harness/providers/cursor/cursor.ts \
  src/integrations/harness/providers/cursor/cursorLive.test.ts
git commit -m "$(cat <<'EOF'
Emit Cursor context from ACP usage_update.

EOF
)"
```

---

### Task 3: Cursor emits `background.updated` while background agents run (Stream A)

**Files:**
- Modify: `src/integrations/harness/providers/cursor/cursor.ts`
- Test: `src/integrations/harness/providers/cursor/cursorLive.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("reports background.updated while a background agent is waiting", async () => {
  const { events, promptId, turn } = await startTurn("cursor-bg-wait");
  emitAgentStart();
  notify("session/update", {
    sessionId: "cursor_1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_agent",
      status: "completed",
      rawOutput: { isBackground: true },
    },
  });
  expect(
    events.some(
      (e) => e.type === "background.updated" && e.tasks.length > 0,
    ),
  ).toBe(true);
  reply(promptId, { stopReason: "end_turn" });
  await turn;
  expect(
    events.some(
      (e) => e.type === "background.updated" && e.tasks.length === 0,
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "reports background.updated"
```

Expected: FAIL.

- [ ] **Step 3: Implement `syncCursorBackgroundWait`**

On `Live`, add `backgroundKey: string` (init `""`). Add:

```typescript
function syncCursorBackgroundWait(live: Live): void {
  const waiting = [...live.backgroundAgentTools].map(
    (callId) => live.agentTools.get(callId) ?? "Background agent",
  );
  const key = waiting.join("\n");
  if (key === live.backgroundKey) return;
  live.backgroundKey = key;
  if (live.muteUpdates) return;
  live.onEvent({ type: "background.updated", tasks: waiting });
}
```

Call `syncCursorBackgroundWait(live)` whenever `backgroundAgentTools` is added to or cleared (after updates in `handleCursorTask`, background tool_call paths, and at the end of `settleCursorBackgroundAgents`).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "reports background.updated"
```

Expected: PASS. Also re-run the existing background subagent tests in the same file.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/harness/providers/cursor/cursor.ts \
  src/integrations/harness/providers/cursor/cursorLive.test.ts
git commit -m "$(cat <<'EOF'
Surface Cursor background agents on the session wait list.

EOF
)"
```

---

### Task 4: Cursor compact via `/compact` when live (Stream A)

**Files:**
- Modify: `src/integrations/harness/providers/cursor/cursor.ts`
- Modify: `src/integrations/harness/providers/cursor/cursorAdapter.ts`
- Test: `src/integrations/harness/providers/cursor/cursorLive.test.ts`
- Optionally touch: `src/integrations/harness/core/registry.test.ts` only if needed

**Capability rule:** Advertise ACP `session.compaction`. Implement `compactContext` by sending a `/compact` prompt on the live session (same pattern other ACP clients use when there is no `session/compact` RPC). Handle `compaction_update` as a status line. If a future Cursor build lacks compact, the prompt fails visibly — do not fake success.

- [ ] **Step 1: Write the failing compact test**

```typescript
it("compacts by prompting /compact on the live ACP session", async () => {
  const { events: _events, promptId, turn } = await startTurn("cursor-compact");
  reply(promptId, { stopReason: "end_turn" });
  await turn;

  const compact = compactCursorContext({
    sessionId: "cursor-compact",
    cwd: "/repo",
    model: "cursor:composer-2.5",
    modelSettings: {},
    runtimeMode: "supervised",
    onEvent: () => undefined,
  });

  await waitFor(
    () =>
      parse().some(
        (message) =>
          message.method === "session/prompt" &&
          JSON.stringify(message.params).includes("/compact"),
      ),
    "compact prompt",
  );
  const compactId = parse().find(
    (message) =>
      message.method === "session/prompt" &&
      JSON.stringify(message.params).includes("/compact"),
  )!.id as number;
  reply(compactId, { stopReason: "end_turn" });
  await compact;
});
```

Export `compactCursorContext` from `cursor.ts` for the test import (mirror other harnesses).

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "compacts by prompting"
```

Expected: FAIL (`compactCursorContext` missing).

- [ ] **Step 3: Implement compact + capabilities**

1. Extend `CLIENT_CAPABILITIES`:

```typescript
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { compaction: {} },
  _meta: { parameterizedModelPicker: true },
};
```

2. In `handleSessionUpdate`, handle `compaction_update`:

```typescript
if (kind === "compaction_update") {
  const status = stringField(update, "status") ?? "in_progress";
  const error = stringField(update, "error");
  live.onEvent({
    type: "status",
    text:
      status === "failed"
        ? error || "Context compaction failed"
        : status === "completed"
          ? "Context compacted"
          : "Compacting context…",
    key: "compaction",
  });
  return;
}
```

3. Add `compactCursorContext`:

```typescript
export async function compactCursorContext(
  input: CompactContextInput,
): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live?.acpSessionId) {
    throw new Error("Cursor session is not connected");
  }
  live.onEvent = input.onEvent;
  await live.acp.request("session/prompt", {
    sessionId: live.acpSessionId,
    prompt: [{ type: "text", text: "/compact" }],
  });
}
```

Import `CompactContextInput` from `../../core/types`.

4. Register on adapter:

```typescript
import { compactCursorContext, /* existing */ } from "./cursor";

export const cursorAdapter: HarnessAdapter = {
  // ...
  compactContext: compactCursorContext,
  // ...
};
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/integrations/harness/providers/cursor/cursorLive.test.ts -t "compacts by prompting"
npx vitest run src/integrations/harness/core/registry.test.ts
```

Expected: PASS. `canCompactHarnessContext("cursor")` becomes true via adapter registration.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/harness/providers/cursor/cursor.ts \
  src/integrations/harness/providers/cursor/cursorAdapter.ts \
  src/integrations/harness/providers/cursor/cursorLive.test.ts
git commit -m "$(cat <<'EOF'
Add Cursor context compaction via ACP /compact.

EOF
)"
```

---

### Task 5: Rust `cursor_mcp_list` (Stream C)

**Files:**
- Modify: `src-tauri/src/harness.rs`
- Modify: `src-tauri/src/lib.rs` (register command)

- [ ] **Step 1: Add the command next to `claude_mcp_list`**

```rust
#[tauri::command]
pub async fn cursor_mcp_list(host: State<'_, HarnessHost>, cwd: String) -> Result<String, String> {
    let binary_path = host.runtime_binary_path("cursor");
    tauri::async_runtime::spawn_blocking(move || {
        let binary = resolve_cursor_binary(binary_path.as_deref())?;
        mcp_command(
            binary,
            vec!["mcp".into(), "list".into()],
            cwd,
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
```

Reuse the same binary resolution helper Cursor spawn already uses in this file (adjust name to match existing `resolve_*` for cursor/agent). If resolution is inlined elsewhere, call that same path — do not invent a second lookup.

- [ ] **Step 2: Register in `lib.rs` invoke handler** next to `claude_mcp_list`:

```rust
harness::cursor_mcp_list,
```

- [ ] **Step 3: Compile-check Rust in the worktree**

```bash
cd src-tauri && cargo check --target-dir /tmp/mc-cursor-claude-target 2>&1 | tail -40
```

Expected: success (or only pre-existing warnings).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/harness.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add cursor_mcp_list for MCP health discovery.

EOF
)"
```

---

### Task 6: Parse + cache Cursor MCP health (Stream C)

**Files:**
- Modify: `src/features/settings/model/mcp.ts`
- Modify: `src/features/settings/model/mcp.test.ts`
- Modify: `src/features/settings/model/mcpSettingsCache.ts`

- [ ] **Step 1: Write failing parse test**

In `mcp.test.ts`:

```typescript
import { parseClaudeMcpList, parseCursorMcpList } from "./mcp";

it("parses agent mcp list lines", () => {
  expect(
    parseCursorMcpList(
      "filesystem: connected\ngithub: needs authentication\nother: error - unreachable",
    ),
  ).toEqual([
    { name: "filesystem", status: "connected" },
    { name: "github", status: "needs authentication" },
    { name: "other", status: "error - unreachable" },
  ]);
});
```

Adjust expected status strings to match real `agent mcp list` output once sampled; if the CLI uses a different layout, update the parser to that layout — never invent health.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/features/settings/model/mcp.test.ts -t "parses agent mcp list"
```

Expected: FAIL.

- [ ] **Step 3: Implement parser + cache load**

In `mcp.ts`:

```typescript
/** Cursor `agent mcp list` — name/status lines; tolerate Claude-like `name: detail`. */
export function parseCursorMcpList(output: string): McpServer[] {
  if (/no mcp servers configured/i.test(output)) return [];
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s+(.+)$/);
    if (!match) return [];
    return [{ name: match[1], status: match[2].trim() }];
  });
}
```

In `mcpSettingsCache.ts`, extend options and loading:

```typescript
options: { claudeHealth?: boolean; cursorHealth?: boolean } = {},
```

After Claude health (or alongside), if `options.cursorHealth`:

```typescript
function loadCursorHealth(cwd: string, discovery: Promise<McpSettingsSnapshot>) {
  // Same request-dedup pattern as loadClaudeHealth, invoking "cursor_mcp_list".
  // Merge status only onto server.provider === "cursor".
  // Store failures in a cursorError field OR reuse a generic side error —
  // prefer adding `cursorError?: string` to the snapshot type next to `claudeError`.
}
```

Call `loadCursorHealth` when `options.cursorHealth` is true.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/features/settings/model/mcp.test.ts
```

Expected: PASS (update `McpSettings.test.ts` mocks to accept `cursor_mcp_list` if they assert invoke allow-lists).

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/model/mcp.ts \
  src/features/settings/model/mcp.test.ts \
  src/features/settings/model/mcpSettingsCache.ts \
  src/features/settings/ui/McpSettings.test.ts
git commit -m "$(cat <<'EOF'
Load Cursor MCP server health into settings cache.

EOF
)"
```

---

### Task 7: Composer picker + statusline Cursor gates (Stream C)

**Files:**
- Modify: `src/features/sessions/ui/Composer.tsx`
- Modify: `src/features/sessions/model/mcpPicker.ts` (if needed for cursor status map)
- Modify: `src/fork/statusline/StatusExtras.tsx`
- Test: `src/features/sessions/ui/Composer.test.ts`, `src/fork/statusline/sessionStatus.test.ts` (or nearest existing)

- [ ] **Step 1: Wire Composer health flags**

Replace the load call:

```typescript
void loadMcpSettings(executionCwd, false, {
  claudeHealth: harness === "claude",
  cursorHealth: harness === "cursor",
});
```

Extend `mcpPickerServers` (or the Composer mapping into it) so Cursor servers use a Cursor status map the same way Claude uses `claudeStatus` — availability from real status text only (`auth` → authentication, `error|failed|…` → unavailable).

- [ ] **Step 2: Fix statusline provider bleed**

In `StatusExtras.tsx` `useSessionStatus`, do **not** pass Cursor sessions into Claude rate-limit cache:

```typescript
const claude = session.harness === "claude";
const rateLimitProvider = ["codex", "opencode", "devin"].includes(session.harness)
  ? (session.harness as "codex" | "opencode" | "devin")
  : claude
    ? "claude"
    : null;
const limits = rateLimitProvider
  ? useCachedRateLimits(rateLimitProvider, session.providerAccountId ?? "default")
  : undefined;
```

Keep Claude status **script** gated on `claude` only (existing). Cursor usage remains the footer chip from Stream B — do not run Claude’s status script for Cursor.

Hooks cannot be conditional — if `useCachedRateLimits` cannot be skipped, call it with a harmless default but **omit** `limits` from the returned `SessionStatus` when `session.harness === "cursor"` (and never treat Cursor as Claude for account metadata). Prefer refactoring the hook usage to stay rules-of-hooks correct.

- [ ] **Step 3: Tests**

- Composer: opening MCP picker on a Cursor harness invokes `cursor_mcp_list` (mock invoke).
- Statusline: Cursor session does not request Claude status script input (`input === null` path).

- [ ] **Step 4: Commit**

```bash
git add src/features/sessions/ui/Composer.tsx \
  src/features/sessions/ui/Composer.test.ts \
  src/features/sessions/model/mcpPicker.ts \
  src/fork/statusline/StatusExtras.tsx \
  src/fork/statusline/sessionStatus.test.ts
git commit -m "$(cat <<'EOF'
Wire Cursor MCP health in composer and keep statusline Claude-only.

EOF
)"
```

---

### Task 8: Claude stream usage on rejected windows (Stream D)

**Files:**
- Modify: `src/fork/usage/claudeStreamUsage.ts` (only if needed)
- Modify: `src/fork/usage/claudeStreamUsage.test.ts`
- Possibly: `src/integrations/harness/providers/claude/claudeProtocol.ts` / `claude.ts` if rejected events never publish usage

- [ ] **Step 1: Write failing test for rejected plan windows**

In `claudeStreamUsage.test.ts`:

```typescript
it("publishes utilization from a rejected rate_limit_event", () => {
  publishClaudeStreamUsage(undefined, {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: 1793100000, status: "rejected" },
        seven_day: { utilization: 0.4, resetsAt: 1793682000, status: "allowed" },
      },
    },
  });
  const usage = getCachedRateLimits("claude", "default");
  expect(usage.session?.usedPercent).toBe(100);
  expect(usage.weekly?.usedPercent).toBeCloseTo(40);
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/fork/usage/claudeStreamUsage.test.ts -t "publishes utilization from a rejected"
```

If it already passes, keep the test as regression coverage and skip Step 3 code changes.

- [ ] **Step 3: Fix only if failing**

Ensure `claudeUsageFromRateLimitEvent` does not require `status: "allowed"`. Publishing must remain independent of `usageLimitFromRateLimitEvent` (limit UX vs footer meters).

Confirm in `claude.ts` that `publishClaudeStreamUsage` still runs for rejected events (it currently runs for all `rate_limit_event`s — do not gate it on allowed).

- [ ] **Step 4: Commit**

```bash
git add src/fork/usage/claudeStreamUsage.ts \
  src/fork/usage/claudeStreamUsage.test.ts
git commit -m "$(cat <<'EOF'
Keep Claude footer usage current on rejected rate limits.

EOF
)"
```

---

### Task 9: Claude audit pass — usage.limited + accounts (Stream D)

**Files:**
- Read: `claude.ts` rate_limit + result handling, `usageLimitFromRateLimitEvent`, auto-account fork
- Modify only with a concrete failing test first
- Test: `claudeProtocol.test.ts` and/or `claudeLive.test.ts`

- [ ] **Step 1: Audit checklist (read-only, note findings in the commit body if no code change)**

Verify:

1. Rejected `rate_limit_event` stored on `live.usageLimit` and emitted as `usage.limited` when the turn errors.
2. Weekly-only / stale 5h window behavior still covered by existing `claudeStreamUsage` tests.
3. Auto-account exhausted switch still offers continue-elsewhere for Claude (Stream B pool includes Cursor as target).

- [ ] **Step 2: If a real gap is found, add a failing test then fix**

Example gap to hunt: rejected event with `resetsAt` but turn ends without `usage.limited`. Test shape:

```typescript
it("emits usage.limited with resetsAt when a rejected window ends the turn", async () => {
  // Drive claudeLive fixture: rate_limit_event rejected, then result is_error.
  // Expect events to include { type: "usage.limited", resetsAt: <ms> }.
});
```

If no gap: commit nothing for this task, or a one-line note in the final integration commit message under “Claude audit: no further code changes”.

- [ ] **Step 3: Commit only if code changed**

```bash
git add src/integrations/harness/providers/claude/claude.ts \
  src/integrations/harness/providers/claude/claudeProtocol.ts \
  src/integrations/harness/providers/claude/claudeLive.test.ts \
  src/integrations/harness/providers/claude/claudeProtocol.test.ts
git commit -m "$(cat <<'EOF'
Fix Claude usage.limited emission when a rejected window ends the turn.

EOF
)"
```

---

### Task 10: Integration gate

**Files:** none new — verify only

- [ ] **Step 1: Run targeted suites**

```bash
npx vitest run \
  src/integrations/harness/providers/cursor/cursorLive.test.ts \
  src/fork/continueElsewhere/continueElsewhere.test.ts \
  src/fork/usage/extraUsage.test.ts \
  src/fork/usage/claudeStreamUsage.test.ts \
  src/features/sessions/model/usageLimit.test.ts \
  src/features/settings/model/mcp.test.ts \
  src/integrations/harness/core/apply.test.ts \
  src/integrations/harness/core/registry.test.ts
```

Expected: all pass.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit --pretty false
```

Expected: exit 0.

- [ ] **Step 3: Spec coverage self-check**

Confirm each spec stream has landed:

| Spec item | Task |
|-----------|------|
| Cursor `context` | 2 |
| Cursor `background.updated` | 3 |
| Cursor `compactContext` / capability | 4 |
| Limits + continue-elsewhere + footer | 1 |
| MCP / composer Cursor health | 5–7 |
| Statusline Claude-only script | 7 |
| Claude stream usage / audit | 8–9 |
| No fake meters / no Cursor account profiles | honored throughout |

- [ ] **Step 4: Final commit only if fixes were needed during the gate**; otherwise stop.

---

## Non-goals (do not implement)

- Cursor multi-account profiles
- Running Claude status scripts for Cursor
- Replacing Cursor ACP with Claude stream-json
- Inventing context % without `usage_update` (or equivalent) fields
