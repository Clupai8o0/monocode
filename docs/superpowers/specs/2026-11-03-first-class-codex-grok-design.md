# First-class Codex & Grok (Claude-parity switching)

**Date:** 2026-11-03  
**Status:** Approved for planning  
**Goal:** Make Claude, Codex, and Grok peers so users can set them up the same way and continue a conversation into any of the other two with rich context.

## Problem

MonoCode already runs many CLIs, but product depth is uneven:

- **Claude** is deeply wired: accounts, usage, MCP settings, hooks, background tasks, continue-elsewhere.
- **Codex** is a near-peer (and ahead on rewind / questions / images) but still misses some Claude session-restore and background parity; continue-elsewhere is hardcoded to Claude only.
- **Grok** is a working ACP adapter with live chat, but it is absent from named accounts, usage footer, MCP Settings discovery, in-app CLI updates, and continue-elsewhere (`continueTarget("grok")` → `null`).

Users cannot easily switch between any of the three. Pairwise `claude ↔ codex` handoff and scattered `claude | codex` allowlists are the bottleneck.

## Approach

**First-class provider contract (Approach 2):** introduce a declarative profile layer above `HarnessAdapter`. UI and continue-elsewhere query capabilities instead of hardcoding harness ids. Claude, Codex, and Grok register as first-class; thinner ACP peers stay out of scope until they opt in.

## Architecture

```
UI / sessions / settings / continue-elsewhere
        │
        ▼
FirstClassProviderProfile (new)
  accounts · usage · mcp · updates · handoff · restore · settingsMap
        │
        ▼
HarnessAdapter (existing)
  send / steer / compact / approvals / bind / …
```

- Live turn protocols stay provider-specific (Claude stream-json, Codex app-server, Grok ACP).
- Product features (Accounts, usage chips, MCP Settings, updates, continue-elsewhere) read profiles.
- In scope as first-class: `claude`, `codex`, `grok`.
- Out of scope: fx, Hermes, Antigravity, etc., unless they later register a profile.

## Components & data model

### `FirstClassProviderProfile`

Each first-class harness registers a profile roughly like:

| Capability | Values / meaning |
|---|---|
| `accounts` | `none` \| `default-only` \| `profiles` — named accounts UI + `providerAccountId` |
| `usage` | `supported` \| `unsupported` — rate-limit footer / `usage.limited` |
| `mcpDiscovery` | whether Settings lists this CLI’s MCP servers |
| `cliUpdates` | whether in-app update harness includes this CLI |
| `handoff` | eligible as continue-elsewhere source and target |
| `restoreTaskLists` | rehydrate todos after restart when adapter supports it |
| `settingsMap` | `toHandoffPrefs` / `fromHandoffPrefs` for cross-provider continue |

Replace hardcoded lists such as `PROVIDER_ACCOUNT_PROVIDERS`, `UPDATABLE_HARNESSES`, MCP provider unions, and pairwise `continueTarget` with profile queries (`firstClassProviders()`, `handoffTargets(from)`, `supportsProviderAccounts(id)`, etc.).

### Rich handoff payload

Extend today’s trimmed brief + local conversation archive:

```ts
type HandoffPayload = {
  brief: string;
  archivePath?: string;
  source: {
    harness: HarnessId;
    sessionId: string;
    accountId?: string;
    throughBlockId?: string;
  };
  preferences: {
    model?: string;
    modelSettings?: Record<string, string>;
    accessMode?: string;
    mcpServerIds?: string[];
    providerAccountId?: string;
  };
};
```

- Mappers live on each profile. Unmappable fields are dropped; never invent models or accounts.
- **Model IDs stay source-native in the payload.** `fromHandoffPrefs` on the target maps or drops them (e.g. Claude model → nearest Codex/Grok equivalent, or omit if none). No separate global neutral model enum in v1.
- `mcpServerIds`: intersect with what the target can discover when possible.
- `providerAccountId`: only applied when the target has compatible account support. Same-provider account reuse is in scope; cross-provider account ids are not portable—fall back to target default.

### Continue-elsewhere UI

- Replace single `continueTarget(): HarnessId | null` with `handoffTargets(from): HarnessId[]` (all other first-class handoff peers).
- Session chrome / usage-limit bar: target picker (“Continue in…”) instead of one fixed peer button.
- `ContinuedOrigin` already carries `from` / `to`; keep that shape.

### Grok profile fill-in (primary)

Wire Grok into every profile surface the CLI allows:

- Accounts: at least `default-only` if the CLI has no isolated profiles; `profiles` only if config-dir isolation exists.
- Usage: `supported` only if a real probe exists; otherwise `unsupported` (no footer spam).
- MCP discovery in Settings; pass discovered servers into sessions where ACP allows (today sessions force `mcpServers: []`).
- In-app CLI updates when an update path exists.
- Handoff eligibility + prefs mappers.
- Restore hooks (`restoreTaskLists`) when ACP/task state allows.

Do not fake steer/rewind if ACP cannot support them; those remain adapter flags (`canSteer: false`).

### Codex profile fill-in (secondary)

Same contract gaps Claude already fills where protocol allows—especially `restoreTaskLists` and background yield/resume parity—not a separate feature track.

## Data flow

### N-way continue-elsewhere

1. User picks a target from `handoffTargets(source)` (not self).
2. Build `HandoffPayload`: brief + archive (existing path) + `preferences` via source `toHandoffPrefs`.
3. Create target session; apply `fromHandoffPrefs` (model / settings / access / MCP / account intersection).
4. Persist `ContinuedOrigin`; start target turn with brief + archive pointer.
5. Handoff recovery / archive chain behavior stays aligned with today’s `handoffContext` flow.

### Peer setup

Settings and session chrome read profiles for accounts, MCP, usage, and updates. Grok appears wherever Claude/Codex do when its profile enables that capability. Missing CLI support → capability off (hidden or clear empty state), not decorative UI.

## Error handling

| Case | Behavior |
|---|---|
| Target not installed / not logged in | Block handoff; prompt install/login for that harness |
| Prefs partially unmappable | Apply what maps; omit the rest |
| Account cannot transfer | Use target default account; optional note on origin card |
| Archive / source session missing | Fail recovery with existing handoff errors |
| Usage API absent | `usage: unsupported`; no probe loop |
| Steer / rewind unsupported | Adapter-level only; not required for handoff |

## Testing

- Unit: profile registry; `handoffTargets`; prefs mappers for Claude ↔ Codex ↔ Grok; payload shape.
- Continue-elsewhere: picker offers two targets; Grok ↔ Claude and Grok ↔ Codex; prefs applied or dropped correctly.
- Regression: existing Claude ↔ Codex brief/archive path.
- Grok wiring smoke tests for accounts / MCP / updates as enabled.
- Codex `restoreTaskLists` (and related restore) when implemented.
- No invented Grok usage probes if the CLI exposes none.

## Non-goals

- Hot-swapping harness on the same tab mid-turn.
- Promoting every ACP peer to first-class in this effort.
- Faking Grok steer/rewind without protocol support.
- Rewriting Claude or Codex live protocols.

## Success criteria

1. User can configure Claude, Codex, and Grok through the same first-class product surfaces (modulo honest capability gaps).
2. From any of the three, user can continue into either of the other two with brief, archive, and best-effort prefs (model, access, MCP, account).
3. No remaining pairwise-only continue-elsewhere for these three; no new `claude \| codex` allowlists for features the profile already covers.
4. Codex closes restore/background gaps that the profile marks supported.

## Implementation notes (for planning)

Key existing touchpoints:

- `src/integrations/harness/core/registry.ts` — `HarnessAdapter`
- `src/fork/continueElsewhere/continueElsewhere.ts` — pairwise `OTHER` map
- `src/fork/continueElsewhere/handoffContext.ts` — archive / recovery
- `src/fork/continueElsewhere/ContinueElsewhereUi.tsx` — single-target button
- `src/features/providers/model/providerAccounts.ts` — account allowlist
- `src/features/settings/model/mcp.ts` — MCP provider union
- `src/features/providers/model/harnessUpdates.ts` — updatable harnesses
- `src/features/providers/model/rateLimits*.ts` — Claude/Codex usage
- `src/integrations/harness/providers/{claude,codex,grok}/` — adapters

Prefer a small new module (e.g. `firstClassProviders.ts` or under `harness/core/`) that owns profiles and queries; migrate call sites incrementally with tests first.
