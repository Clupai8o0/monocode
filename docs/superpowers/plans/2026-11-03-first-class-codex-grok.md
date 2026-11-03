# First-class Codex & Grok Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude, Codex, and Grok first-class peers via a shared capability profile so users can configure them the same way and continue a conversation into either of the other two with brief, archive, and best-effort preferences.

**Architecture:** Add `FirstClassProviderProfile` above `HarnessAdapter`. Product surfaces (accounts, MCP Settings, usage, updates, continue-elsewhere) query profiles instead of `claude | codex` allowlists. Handoff becomes N-way with a target picker and preference mappers. Grok fills honest capabilities (default-only accounts, MCP discovery, handoff); usage/CLI updates stay off until real backends exist. Codex gets restore parity only where provider-side state actually needs seeding.

**Tech Stack:** TypeScript (React/Vite), Vitest, Tauri/Rust (`mcp.rs`), existing harness registry and continue-elsewhere fork.

**Spec:** `docs/superpowers/specs/2026-11-03-first-class-codex-grok-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/integrations/harness/core/firstClassProviders.ts` | Profile type, built-in Claude/Codex/Grok profiles, query helpers, handoff pref mappers |
| `src/integrations/harness/core/firstClassProviders.test.ts` | Profile + handoffTargets + mapper unit tests |
| `src/fork/continueElsewhere/continueElsewhere.ts` | Replace pairwise map with profile-backed `handoffTargets`; extend `ContinueHost` |
| `src/fork/continueElsewhere/ContinueElsewhereUi.tsx` | Target picker UI |
| `src/fork/continueElsewhere/handoffPrefs.ts` | Build/apply `HandoffPayload.preferences` (keeps App thinner) |
| `src/app/App.tsx` | `continueSession(sessionId, target)` + apply prefs in `onHandoff` |
| `src/app/shell/Sidebar.tsx` | Multi-target continue menu items |
| `src/features/providers/model/providerAccounts.ts` | Derive allowlists from profiles; add Grok default-only |
| `src/features/providers/model/harnessUpdates.ts` | Derive updatable set from profiles (`cliUpdates`) |
| `src/features/providers/model/rateLimits.ts` / `SessionPane.tsx` | Derive usage providers from profiles |
| `src/features/settings/model/mcp.ts` | Add `"grok"` to MCP provider union + label |
| `src-tauri/src/mcp.rs` | Discover `~/.grok/config.toml` and project `.grok/config.toml` |
| `src/integrations/harness/providers/codex/*` | `restoreTaskLists` only if Codex keeps in-memory task ids (see Task 8) |
| `src/integrations/harness/index.ts` | Re-export profile helpers used by UI |

**Honest capability matrix (v1):**

| | Claude | Codex | Grok |
|---|---|---|---|
| accounts | profiles | profiles | default-only |
| usage | supported | supported | unsupported |
| mcpDiscovery | yes | yes | yes (new) |
| cliUpdates | yes | yes | no (no npm updater) |
| handoff | yes | yes | yes |
| restoreTaskLists | yes | only if needed | no (ACP has no Claude-style TaskUpdate map) |

---

### Task 1: First-class provider profile module

**Files:**
- Create: `src/integrations/harness/core/firstClassProviders.ts`
- Create: `src/integrations/harness/core/firstClassProviders.test.ts`
- Modify: `src/integrations/harness/index.ts` (re-export public helpers)

- [ ] **Step 1: Write the failing tests**

```ts
// src/integrations/harness/core/firstClassProviders.test.ts
import { describe, expect, it } from "vitest";
import {
  firstClassProviders,
  getFirstClassProfile,
  handoffTargets,
  supportsFirstClassAccounts,
  supportsFirstClassHandoff,
  supportsFirstClassMcpDiscovery,
  supportsFirstClassUsage,
  supportsFirstClassCliUpdates,
} from "./firstClassProviders";

describe("firstClassProviders", () => {
  it("registers claude, codex, and grok only", () => {
    expect(firstClassProviders().sort()).toEqual(["claude", "codex", "grok"]);
  });

  it("exposes honest capabilities", () => {
    expect(getFirstClassProfile("claude")?.accounts).toBe("profiles");
    expect(getFirstClassProfile("codex")?.accounts).toBe("profiles");
    expect(getFirstClassProfile("grok")?.accounts).toBe("default-only");
    expect(supportsFirstClassUsage("claude")).toBe(true);
    expect(supportsFirstClassUsage("grok")).toBe(false);
    expect(supportsFirstClassCliUpdates("codex")).toBe(true);
    expect(supportsFirstClassCliUpdates("grok")).toBe(false);
    expect(supportsFirstClassMcpDiscovery("grok")).toBe(true);
    expect(supportsFirstClassAccounts("devin")).toBe(false);
  });

  it("offers every other handoff peer", () => {
    expect(handoffTargets("claude").sort()).toEqual(["codex", "grok"]);
    expect(handoffTargets("codex").sort()).toEqual(["claude", "grok"]);
    expect(handoffTargets("grok").sort()).toEqual(["claude", "codex"]);
    expect(supportsFirstClassHandoff("fx")).toBe(false);
    expect(handoffTargets("fx")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/integrations/harness/core/firstClassProviders.test.ts`

Expected: FAIL — cannot find module `./firstClassProviders`

- [ ] **Step 3: Implement the module**

```ts
// src/integrations/harness/core/firstClassProviders.ts
import type { HarnessId } from "../../../features/sessions/model/session";
import type { RuntimeMode } from "../../../features/sessions/model/session";

export type AccountCapability = "none" | "default-only" | "profiles";
export type UsageCapability = "supported" | "unsupported";

export type HandoffPreferences = {
  model?: string;
  modelSettings?: Record<string, string>;
  accessMode?: RuntimeMode;
  mcpServerIds?: string[];
  providerAccountId?: string;
};

export type FirstClassProviderProfile = {
  id: HarnessId;
  accounts: AccountCapability;
  usage: UsageCapability;
  mcpDiscovery: boolean;
  cliUpdates: boolean;
  handoff: boolean;
  restoreTaskLists: boolean;
  /** Copy source-native prefs into the payload. */
  toHandoffPrefs: (input: {
    model: string;
    modelSettings: Record<string, string>;
    runtimeMode: RuntimeMode;
    providerAccountId?: string;
    mcpServerIds?: string[];
  }) => HandoffPreferences;
  /**
   * Map payload prefs onto this target. Drop unmappable fields.
   * Cross-provider account ids are never portable — omit providerAccountId.
   */
  fromHandoffPrefs: (
    prefs: HandoffPreferences,
    helpers: {
      defaultModelId: (harness: HarnessId) => string;
      isKnownModel: (harness: HarnessId, model: string) => boolean;
    },
  ) => {
    model: string;
    modelSettings: Record<string, string>;
    runtimeMode?: RuntimeMode;
    mcpServerIds?: string[];
  };
};

function identityToPrefs(input: {
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  providerAccountId?: string;
  mcpServerIds?: string[];
}): HandoffPreferences {
  return {
    model: input.model,
    modelSettings: { ...input.modelSettings },
    accessMode: input.runtimeMode,
    ...(input.providerAccountId
      ? { providerAccountId: input.providerAccountId }
      : {}),
    ...(input.mcpServerIds?.length
      ? { mcpServerIds: [...input.mcpServerIds] }
      : {}),
  };
}

function mapIncomingPrefs(
  id: HarnessId,
  prefs: HandoffPreferences,
  helpers: {
    defaultModelId: (harness: HarnessId) => string;
    isKnownModel: (harness: HarnessId, model: string) => boolean;
  },
  runtimeModeOverride?: RuntimeMode,
): {
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode?: RuntimeMode;
  mcpServerIds?: string[];
} {
  const model =
    prefs.model && helpers.isKnownModel(id, prefs.model)
      ? prefs.model
      : helpers.defaultModelId(id);
  return {
    model,
    modelSettings: { ...(prefs.modelSettings ?? {}) },
    runtimeMode: runtimeModeOverride ?? prefs.accessMode,
    ...(prefs.mcpServerIds?.length
      ? { mcpServerIds: [...prefs.mcpServerIds] }
      : {}),
  };
}

const PROFILES: FirstClassProviderProfile[] = [
  {
    id: "claude",
    accounts: "profiles",
    usage: "supported",
    mcpDiscovery: true,
    cliUpdates: true,
    handoff: true,
    restoreTaskLists: true,
    toHandoffPrefs: identityToPrefs,
    fromHandoffPrefs: (prefs, helpers) => mapIncomingPrefs("claude", prefs, helpers),
  },
  {
    id: "codex",
    accounts: "profiles",
    usage: "supported",
    mcpDiscovery: true,
    cliUpdates: true,
    handoff: true,
    restoreTaskLists: false, // flipped in Task 8 only if Codex needs in-memory seed
    toHandoffPrefs: identityToPrefs,
    fromHandoffPrefs: (prefs, helpers) =>
      mapIncomingPrefs("codex", prefs, helpers, "full-access"),
  },
  {
    id: "grok",
    accounts: "default-only",
    usage: "unsupported",
    mcpDiscovery: true,
    cliUpdates: false,
    handoff: true,
    restoreTaskLists: false,
    toHandoffPrefs: identityToPrefs,
    fromHandoffPrefs: (prefs, helpers) => mapIncomingPrefs("grok", prefs, helpers),
  },
];

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

export function firstClassProviders(): HarnessId[] {
  return PROFILES.map((profile) => profile.id);
}

export function getFirstClassProfile(
  id: HarnessId,
): FirstClassProviderProfile | undefined {
  return BY_ID.get(id);
}

export function supportsFirstClassHandoff(id: HarnessId): boolean {
  return BY_ID.get(id)?.handoff === true;
}

export function handoffTargets(from: HarnessId): HarnessId[] {
  if (!supportsFirstClassHandoff(from)) return [];
  return PROFILES.filter((profile) => profile.handoff && profile.id !== from).map(
    (profile) => profile.id,
  );
}

export function supportsFirstClassAccounts(id: HarnessId): boolean {
  const accounts = BY_ID.get(id)?.accounts;
  return accounts === "default-only" || accounts === "profiles";
}

export function supportsFirstClassAccountProfiles(id: HarnessId): boolean {
  return BY_ID.get(id)?.accounts === "profiles";
}

export function supportsFirstClassUsage(id: HarnessId): boolean {
  return BY_ID.get(id)?.usage === "supported";
}

export function supportsFirstClassMcpDiscovery(id: HarnessId): boolean {
  return BY_ID.get(id)?.mcpDiscovery === true;
}

export function supportsFirstClassCliUpdates(id: HarnessId): boolean {
  return BY_ID.get(id)?.cliUpdates === true;
}
```

Re-export from `src/integrations/harness/index.ts`:

```ts
export {
  firstClassProviders,
  getFirstClassProfile,
  handoffTargets,
  supportsFirstClassAccounts,
  supportsFirstClassAccountProfiles,
  supportsFirstClassUsage,
  supportsFirstClassMcpDiscovery,
  supportsFirstClassCliUpdates,
  supportsFirstClassHandoff,
} from "./core/firstClassProviders";
export type {
  FirstClassProviderProfile,
  HandoffPreferences,
} from "./core/firstClassProviders";
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/integrations/harness/core/firstClassProviders.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/integrations/harness/core/firstClassProviders.ts \
  src/integrations/harness/core/firstClassProviders.test.ts \
  src/integrations/harness/index.ts
git commit -m "$(cat <<'EOF'
Add first-class provider profiles for Claude, Codex, and Grok.

EOF
)"
```

---

### Task 2: N-way `handoffTargets` in continue-elsewhere

**Files:**
- Modify: `src/fork/continueElsewhere/continueElsewhere.ts`
- Modify: `src/fork/continueElsewhere/continueElsewhere.test.ts`

- [ ] **Step 1: Update tests for N-way targets**

Replace the `continueTarget` describe block with:

```ts
import {
  continuedOrigin,
  continueLabel,
  continueTarget,
  handoffTargets,
  saveContinuedOrigin,
  withTranscriptPointer,
  type ContinuedOrigin,
} from "./continueElsewhere";

describe("handoffTargets", () => {
  it("offers the other first-class peers", () => {
    expect(handoffTargets("claude").sort()).toEqual(["codex", "grok"]);
    expect(handoffTargets("codex").sort()).toEqual(["claude", "grok"]);
    expect(handoffTargets("grok").sort()).toEqual(["claude", "codex"]);
  });

  it("keeps continueTarget as the primary peer for single-button callers", () => {
    // Prefer Codex for Claude and Claude for Codex (historical default);
    // Grok's primary peer is Claude.
    expect(continueTarget("claude")).toBe("codex");
    expect(continueTarget("codex")).toBe("claude");
    expect(continueTarget("grok")).toBe("claude");
    expect(continueLabel("grok")).toBe("Continue in Claude Code");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** on `handoffTargets` / Grok `continueTarget`

Run: `npx vitest run src/fork/continueElsewhere/continueElsewhere.test.ts`

- [ ] **Step 3: Implement**

In `continueElsewhere.ts`, replace the pairwise `OTHER` map:

```ts
import { handoffTargets as profileHandoffTargets } from "../../integrations/harness/core/firstClassProviders";
import type { HarnessId } from "../../features/sessions/model/session";
import { HARNESS_TITLE } from "../../features/sessions/model/session";

export function handoffTargets(harness: HarnessId): HarnessId[] {
  return profileHandoffTargets(harness);
}

/** Preferred single target when the UI has not picked one yet. */
const PRIMARY: Partial<Record<HarnessId, HarnessId>> = {
  claude: "codex",
  codex: "claude",
  grok: "claude",
};

export function continueTarget(harness: HarnessId): HarnessId | null {
  const targets = handoffTargets(harness);
  if (targets.length === 0) return null;
  const preferred = PRIMARY[harness];
  return preferred && targets.includes(preferred) ? preferred : targets[0];
}

export function continueLabel(harness: HarnessId): string | null {
  const target = continueTarget(harness);
  return target ? `Continue in ${HARNESS_TITLE[target]}` : null;
}

export function continueLabelFor(
  harness: HarnessId,
  target: HarnessId,
): string {
  return `Continue in ${HARNESS_TITLE[target]}`;
}
```

Keep `ContinueHost` unchanged in this task (still single-arg); Task 3 extends it.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run src/fork/continueElsewhere/continueElsewhere.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/fork/continueElsewhere/continueElsewhere.ts \
  src/fork/continueElsewhere/continueElsewhere.test.ts
git commit -m "$(cat <<'EOF'
Offer Claude, Codex, and Grok as continue-elsewhere peers.

EOF
)"
```

---

### Task 3: Target picker API + UI

**Files:**
- Modify: `src/fork/continueElsewhere/continueElsewhere.ts` (`ContinueHost`)
- Modify: `src/fork/continueElsewhere/ContinueElsewhereUi.tsx`
- Modify: `src/app/App.tsx` (registerContinueHost)
- Modify: `src/app/shell/Sidebar.tsx`
- Modify: `tests/browser/continue-elsewhere.tsx` if the button API changes
- Test: extend `continueElsewhere.test.ts` for host typing if needed; add a small UI unit test if the repo already tests this fork UI — otherwise rely on App wiring + browser fixture update

- [ ] **Step 1: Extend `ContinueHost`**

```ts
export type ContinueHost = {
  canContinue: (sessionId: string) => boolean;
  /** `target` required when multiple peers exist; omit only for primary default. */
  continueSession: (sessionId: string, target?: HarnessId) => void;
  openSession: (sessionId: string) => void;
  /** Live handoff peers for a session (installed/live filtered by the host). */
  targetsFor?: (sessionId: string) => HarnessId[];
};
```

- [ ] **Step 2: Update App.tsx host registration** (~11040–11070)

```ts
registerContinueHost({
  canContinue: (sessionId) => {
    const source = sessionsRef.current.find((s) => s.id === sessionId);
    if (!source || source.worktreeRemoved || remoteProjectFor(source.cwd)) {
      return false;
    }
    return handoffTargets(source.harness).some((id) => isLiveHarness(id));
  },
  targetsFor: (sessionId) => {
    const source = sessionsRef.current.find((s) => s.id === sessionId);
    if (!source || source.worktreeRemoved || remoteProjectFor(source.cwd)) {
      return [];
    }
    return handoffTargets(source.harness).filter((id) => isLiveHarness(id));
  },
  continueSession: (sessionId, target) => {
    const source = sessionsRef.current.find((s) => s.id === sessionId);
    if (!source || source.worktreeRemoved || remoteProjectFor(source.cwd)) {
      return;
    }
    const allowed = handoffTargets(source.harness).filter((id) =>
      isLiveHarness(id),
    );
    const resolved =
      (target && allowed.includes(target) ? target : null) ??
      continueTarget(source.harness);
    if (!resolved || !allowed.includes(resolved)) return;
    // Prefs applied in Task 4; for now still defaultModelId(resolved).
    const model = defaultModelId(resolved);
    onHandoff(
      sessionId,
      {
        harness: resolved,
        model,
        modelSettings: defaultModelSettings(resolveModel(resolved, model)),
      },
      source.blocks,
    );
  },
  openSession: (sessionId) => {
    onSelectHistorySessionRef.current(sessionId);
  },
});
```

Import `handoffTargets` from the continue-elsewhere module (re-exported) or harness core.

- [ ] **Step 3: Update `ContinueElsewhereButton` to a picker when `targets.length > 1`**

Behavior:
- 0 targets → render null
- 1 target → single button (today’s look) calling `continueSession(id, target)`
- 2+ targets → button opens a small menu listing each `continueLabelFor(harness, target)`

Use existing menu/popover patterns nearby in the usage-limit UI if present; otherwise a minimal absolute menu with the same `PRESS` classes as the current button. Keep `data-fork-continue-elsewhere` on the control for fixtures.

- [ ] **Step 4: Sidebar menu — one item per target**

Replace the single `continue-elsewhere` item with:

```ts
...( !multipleMenuSessions && menuSessions[0]
  ? (continueHost()?.targetsFor?.(menuSessions[0].id) ??
      handoffTargets(menuSessions[0].harness)
    ).map((target) => ({
      kind: "item" as const,
      id: `continue-elsewhere:${target}`,
      label: continueLabelFor(menuSessions[0].harness, target),
      disabled: !continueHost()?.canContinue(menuSessions[0].id),
      description: continueHost()?.canContinue(menuSessions[0].id)
        ? undefined
        : "Open the session first",
    }))
  : []),
```

Handler:

```ts
if (id.startsWith("continue-elsewhere:")) {
  const target = id.slice("continue-elsewhere:".length) as HarnessId;
  continueHost()?.continueSession(sessionIds[0], target);
  return;
}
```

- [ ] **Step 5: Update browser fixture** `tests/browser/continue-elsewhere.tsx` so Claude still shows a continue control (Codex and/or Grok in menu is fine).

- [ ] **Step 6: Run unit tests**

Run: `npx vitest run src/fork/continueElsewhere/`

- [ ] **Step 7: Commit**

```bash
git add src/fork/continueElsewhere src/app/App.tsx src/app/shell/Sidebar.tsx \
  tests/browser/continue-elsewhere.tsx
git commit -m "$(cat <<'EOF'
Add continue-elsewhere target picker across first-class peers.

EOF
)"
```

---

### Task 4: Rich handoff preferences

**Files:**
- Create: `src/fork/continueElsewhere/handoffPrefs.ts`
- Create: `src/fork/continueElsewhere/handoffPrefs.test.ts`
- Modify: `src/app/App.tsx` (`onHandoff` + `continueSession`)
- Modify: `src/features/sessions/model/draftCache.ts` usage from App (copy MCP tags)

- [ ] **Step 1: Failing tests for mappers**

```ts
// src/fork/continueElsewhere/handoffPrefs.test.ts
import { describe, expect, it } from "vitest";
import { buildHandoffTarget, sourceHandoffPrefs } from "./handoffPrefs";

const helpers = {
  defaultModelId: (harness: "claude" | "codex" | "grok") =>
    ({ claude: "claude:default", codex: "codex:default", grok: "grok:grok-4.7" })[
      harness
    ],
  isKnownModel: (harness: string, model: string) => model.startsWith(`${harness}:`),
};

describe("handoffPrefs", () => {
  it("copies source-native prefs", () => {
    expect(
      sourceHandoffPrefs({
        harness: "claude",
        model: "claude:opus",
        modelSettings: { effort: "high" },
        runtimeMode: "supervised",
        providerAccountId: "work",
        mcpServerIds: ["filesystem"],
      }),
    ).toMatchObject({
      model: "claude:opus",
      modelSettings: { effort: "high" },
      accessMode: "supervised",
      providerAccountId: "work",
      mcpServerIds: ["filesystem"],
    });
  });

  it("maps to Codex with full-access and drops unknown models", () => {
    const target = buildHandoffTarget(
      "codex",
      {
        model: "claude:opus",
        modelSettings: { effort: "high" },
        accessMode: "supervised",
        mcpServerIds: ["filesystem"],
      },
      helpers,
    );
    expect(target.model).toBe("codex:default");
    expect(target.runtimeMode).toBe("full-access");
    expect(target.modelSettings.effort).toBe("high");
  });

  it("keeps a known Grok model when continuing to Grok", () => {
    const target = buildHandoffTarget(
      "grok",
      { model: "grok:grok-4.7", modelSettings: { effort: "low" }, accessMode: "auto" },
      helpers,
    );
    expect(target.model).toBe("grok:grok-4.7");
    expect(target.runtimeMode).toBe("auto");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/fork/continueElsewhere/handoffPrefs.test.ts`

- [ ] **Step 3: Implement `handoffPrefs.ts`**

```ts
import type { HarnessId, RuntimeMode } from "../../features/sessions/model/session";
import {
  getFirstClassProfile,
  type HandoffPreferences,
} from "../../integrations/harness/core/firstClassProviders";

export function sourceHandoffPrefs(input: {
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  providerAccountId?: string;
  mcpServerIds?: string[];
}): HandoffPreferences {
  const profile = getFirstClassProfile(input.harness);
  if (!profile) {
    return {
      model: input.model,
      modelSettings: { ...input.modelSettings },
      accessMode: input.runtimeMode,
    };
  }
  return profile.toHandoffPrefs(input);
}

export function buildHandoffTarget(
  target: HarnessId,
  prefs: HandoffPreferences,
  helpers: {
    defaultModelId: (harness: HarnessId) => string;
    isKnownModel: (harness: HarnessId, model: string) => boolean;
  },
): {
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode?: RuntimeMode;
  mcpServerIds?: string[];
} {
  const profile = getFirstClassProfile(target);
  const mapped = profile
    ? profile.fromHandoffPrefs(prefs, helpers)
    : {
        model: helpers.defaultModelId(target),
        modelSettings: {},
      };
  return { harness: target, ...mapped };
}
```

Wire real helpers in App using `defaultModelId` and `resolveModel(harness, model) != null` (or whatever the catalog uses for “known”).

- [ ] **Step 4: Apply in `continueSession` / `onHandoff`**

In `continueSession`, replace blind `defaultModelId` with:

```ts
const prefs = sourceHandoffPrefs({
  harness: source.harness,
  model: source.model,
  modelSettings: source.modelSettings,
  runtimeMode: source.runtimeMode,
  providerAccountId: source.providerAccountId,
  mcpServerIds: getComposerMcpTags(source.id).map((tag) => tag.server.name),
});
const mapped = buildHandoffTarget(resolved, prefs, {
  defaultModelId,
  isKnownModel: (harness, model) => resolveModel(harness, model) != null,
});
onHandoff(
  sessionId,
  {
    harness: mapped.harness,
    model: mapped.model,
    modelSettings: mapped.modelSettings,
  },
  source.blocks,
  { runtimeMode: mapped.runtimeMode, mcpServerIds: mapped.mcpServerIds },
);
```

Extend `onHandoff` to accept optional extras:

```ts
(
  sourceId: string,
  target: ModelTarget,
  turn: Block[],
  extras?: { runtimeMode?: RuntimeMode; mcpServerIds?: string[] },
) => {
  // ...
  const session = {
    ...newSession(
      harness,
      source.cwd,
      model,
      extras?.runtimeMode ??
        (harness === "codex" ? "full-access" : source.runtimeMode),
    ),
    // ... existing fields ...
  };
  // after openSessionBeside / once session.id exists:
  if (extras?.mcpServerIds?.length) {
    // Best-effort: keep names only; tags need McpConnection objects.
    // v1: copy source composer tags whose server.name is in mcpServerIds
    // and whose provider matches target harness when possible.
    const sourceTags = getComposerMcpTags(sourceId).filter((tag) =>
      extras.mcpServerIds!.includes(tag.server.name),
    );
    const remapped = sourceTags
      .filter(
        (tag) =>
          tag.server.provider === harness ||
          // grok/codex/claude discovery providers use the harness id
          tag.server.provider === (harness as typeof tag.server.provider),
      )
      .map((tag) => ({ ...tag, server: { ...tag.server, provider: harness as typeof tag.server.provider } }));
    if (remapped.length) setComposerMcpTags(session.id, remapped);
  }
}
```

If remapping `McpConnection.provider` is too awkward before Grok is in the union (Task 5/7), copy only same-provider tags in this task and expand after `"grok"` is a valid provider.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/fork/continueElsewhere/`

- [ ] **Step 6: Commit**

```bash
git add src/fork/continueElsewhere/handoffPrefs.ts \
  src/fork/continueElsewhere/handoffPrefs.test.ts \
  src/app/App.tsx
git commit -m "$(cat <<'EOF'
Carry model, access mode, and MCP tags on continue-elsewhere handoffs.

EOF
)"
```

---

### Task 5: Accounts — profile-backed allowlist + Grok default-only

**Files:**
- Modify: `src/features/providers/model/providerAccounts.ts`
- Modify: related tests (`providerAccounts` tests if any; `SettingsView` account list tests)

- [ ] **Step 1: Failing test — Grok supports accounts, not profiles**

Add/adjust:

```ts
expect(supportsProviderAccounts("grok")).toBe(true);
expect(supportsAccountProfiles("grok")).toBe(false);
expect(providerAccounts("grok").some((a) => a.id === "default")).toBe(true);
```

- [ ] **Step 2: Run — expect FAIL** (`grok` not in `PROVIDER_ACCOUNT_PROVIDERS`)

- [ ] **Step 3: Implement**

```ts
import {
  firstClassProviders,
  supportsFirstClassAccounts,
  supportsFirstClassAccountProfiles,
} from "../../../integrations/harness/core/firstClassProviders";

// Keep Devin as a special non-first-class account provider.
const EXTRA_ACCOUNT_PROVIDERS = ["devin"] as const satisfies readonly HarnessId[];

export const PROVIDER_ACCOUNT_PROVIDERS = [
  ...firstClassProviders().filter(supportsFirstClassAccounts),
  ...EXTRA_ACCOUNT_PROVIDERS,
] as const;

// If `as const` + spread typing fights you, build a runtime array and type:
// export type ProviderAccountProvider = (typeof PROVIDER_ACCOUNT_PROVIDERS)[number];
// with PROVIDER_ACCOUNT_PROVIDERS: readonly HarnessId[] narrowed by a satisfies check in tests.

export function supportsAccountProfiles(
  provider: HarnessId,
): provider is ProfileAccountProvider {
  return supportsFirstClassAccountProfiles(provider);
}
```

Ensure `"grok"` is **not** treated as a profile provider (Rust `provider_account_path` still rejects non-claude/codex — correct for default-only).

- [ ] **Step 4: Run account-related tests**

Run: `npx vitest run src/features/providers/model/providerAccounts.ts src/features/providers src/features/settings/ui/SettingsView.test.ts 2>/dev/null; npx vitest run --dir src/features/providers`

(Use the actual test path that covers accounts — search `supportsProviderAccounts` if needed.)

- [ ] **Step 5: Commit**

```bash
git add src/features/providers/model/providerAccounts.ts src/features/providers/**/*.test.ts
git commit -m "$(cat <<'EOF'
List Grok under Accounts as a default-only provider.

EOF
)"
```

---

### Task 6: Usage + CLI updates from profiles

**Files:**
- Modify: `src/features/providers/model/harnessUpdates.ts`
- Modify: `src/features/sessions/ui/SessionPane.tsx` (`monoUsageProviders`)
- Optionally: `src/features/providers/model/rateLimits.ts` docs/comments only — keep `RateLimitProvider` union as the set of *fetchers*; gate with `supportsFirstClassUsage` / profile for first-class ones, and keep opencode/devin as extras like accounts

- [ ] **Step 1: Test that Grok is not updatable and has no usage footer providers**

```ts
import { UPDATABLE_HARNESSES } from "./harnessUpdates";
import { supportsFirstClassCliUpdates, supportsFirstClassUsage } from "../../../integrations/harness/core/firstClassProviders";

expect(supportsFirstClassCliUpdates("grok")).toBe(false);
expect(UPDATABLE_HARNESSES.has("grok")).toBe(false);
expect(supportsFirstClassUsage("grok")).toBe(false);
```

For `monoUsageProviders`, extract to a tiny helper if needed so it can be unit-tested:

```ts
// e.g. src/features/providers/model/usageProviders.ts
export function monoUsageProviders(harness: HarnessId): RateLimitProvider[] {
  const extras: RateLimitProvider[] = [];
  if (harness === "opencode" || harness === "devin") extras.push(harness);
  if (supportsFirstClassUsage(harness)) {
    return [harness as RateLimitProvider, ...extras.filter((e) => e !== harness)];
  }
  return extras.filter((e) => e === harness);
}
```

- [ ] **Step 2: Implement profile-backed `UPDATABLE_HARNESSES`**

```ts
import {
  firstClassProviders,
  supportsFirstClassCliUpdates,
} from "../../../integrations/harness/core/firstClassProviders";

const EXTRA_UPDATABLE = ["opencode", "pi"] as const;

export const UPDATABLE_HARNESSES: ReadonlySet<HarnessId> = new Set([
  ...firstClassProviders().filter(supportsFirstClassCliUpdates),
  ...EXTRA_UPDATABLE,
]);
```

Do **not** add Grok to Rust `harness_updates.rs`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/features/providers/model/harnessUpdates.ts src/fork/usage src/features/providers`

- [ ] **Step 4: Commit**

```bash
git add src/features/providers/model/harnessUpdates.ts \
  src/features/sessions/ui/SessionPane.tsx \
  src/features/providers/model/usageProviders.ts # if created
git commit -m "$(cat <<'EOF'
Drive usage footer and CLI updates from first-class profiles.

EOF
)"
```

---

### Task 7: Grok MCP discovery (Settings)

**Files:**
- Modify: `src/features/settings/model/mcp.ts`
- Modify: `src-tauri/src/mcp.rs` (`discover` + tests)
- Modify: `src/features/settings/model/mcpSettingsCache.test.ts` / `McpSettings.test.ts` as needed
- Modify: handoff MCP remapping from Task 4 now that `"grok"` is a valid provider

- [ ] **Step 1: TS — add grok to the union**

```ts
export type McpConnection = {
  provider: "claude" | "claude_desktop" | "codex" | "cursor" | "opencode" | "grok";
  // ...
};

export const MCP_PROVIDER_LABELS: Record<McpConnection["provider"], string> = {
  // ...existing
  grok: "Grok Build",
};
```

- [ ] **Step 2: Rust — discover Grok configs (same `mcp_servers` TOML shape as Codex)**

In `discover(...)` after Codex user home block, add:

```rust
let grok_home = std::env::var_os("GROK_HOME")
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join(".grok"));
add_toml_file(
    &mut connections,
    "grok",
    "user",
    &grok_home.join("config.toml"),
);
```

In the project ancestor loop, alongside `.codex/config.toml`:

```rust
add_toml_file(
    &mut connections,
    "grok",
    "project",
    &directory.join(".grok/config.toml"),
);
```

- [ ] **Step 3: Rust test** in `mcp.rs` tests module — write a temp home with `~/.grok/config.toml` containing `[mcp_servers.demo]\ncommand = 'node'\n` and assert discovery returns `provider == "grok"`, `name == "demo"`, credentials not leaked (follow existing Codex discovery test style ~1062).

- [ ] **Step 4: Run**

```bash
npx vitest run src/features/settings/model
cargo test --manifest-path src-tauri/Cargo.toml discovers_provider_configs -- --nocapture
```

Add a sibling Rust unit test next to `discovers_provider_configs_without_exposing_credentials` that covers `~/.grok/config.toml`.

- [ ] **Step 5: Note on `mcpServers: []` in Grok ACP**

Grok Build loads MCP from its own `config.toml` at process start. Keep passing `mcpServers: []` in `session/new` unless you are injecting *additional* MonoCode-managed servers. Settings discovery is the product gap; do not double-spawn by echoing the same servers into ACP without an explicit product need.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/model/mcp.ts src-tauri/src/mcp.rs \
  src/features/settings/**/*.test.ts
git commit -m "$(cat <<'EOF'
Discover Grok Build MCP servers in Settings.

EOF
)"
```

---

### Task 8: Codex `restoreTaskLists` (conditional)

**Files:**
- Investigate: `src/integrations/harness/providers/codex/codex.ts`, `codexProtocol.ts`, `codexAdapter.ts`
- Possibly mirror: `restoreClaudeTaskLists` pattern

- [ ] **Step 1: Investigate**

Claude’s `restoreTaskLists` seeds an in-memory `tasksByThread` map so later `TaskUpdate` tools resolve ids after app restart. Codex emits full `turn/plan/updated` snapshots as `tasks.updated` and does **not** maintain a Claude-style id map today.

- [ ] **Step 2: Decision gate**

- If no Codex in-memory task id map exists and resume does not break plan updates: **leave `restoreTaskLists: false`** on the Codex profile. Add a short comment in `firstClassProviders.ts` pointing at this investigation. Skip implementation.
- If you find Codex code that fails to update plans after rebind without a seed: implement `restoreCodexTaskLists` analogous to Claude (key whatever Codex puts on `TaskListMeta.key`), wire `codexAdapter.restoreTaskLists`, set profile `restoreTaskLists: true`, and add a unit test mirroring `registry.test.ts` restore coverage.

- [ ] **Step 3: Commit only if code changed**

```bash
git commit -m "$(cat <<'EOF'
Restore Codex task lists after session rebind.

EOF
)"
```

Or commit a comment-only clarification:

```bash
git commit -m "$(cat <<'EOF'
Document why Codex skips restoreTaskLists in the first-class profile.

EOF
)"
```

**Background yield / hooks:** out of scope for v1 (Claude-specific stream + settings). Do not fake them on Codex/Grok.

---

### Task 9: End-to-end verification

- [ ] **Step 1: Unit suite for touched areas**

```bash
npx vitest run \
  src/integrations/harness/core/firstClassProviders.test.ts \
  src/fork/continueElsewhere \
  src/features/providers \
  src/features/settings/model
```

Expected: PASS

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Manual smoke (if desktop available)**

1. Settings → Accounts shows Grok (default only; no “Add account” profile flow).
2. Settings → MCP lists servers from `~/.grok/config.toml` when present.
3. From a Claude session menu: “Continue in Codex” and “Continue in Grok Build”.
4. From Grok: continue to Claude and Codex; brief + origin card appear; Codex session gets full-access.
5. Usage footer still absent on Grok; still present on Claude/Codex.

- [ ] **Step 4: Final commit if verification fixed anything**; otherwise done.

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| FirstClassProviderProfile contract | 1 |
| Replace pairwise continue with N-way | 2–3 |
| Rich handoff prefs (model/settings/access/MCP/account policy) | 4 |
| Grok accounts default-only | 5 |
| Usage unsupported for Grok; no probe spam | 6 |
| CLI updates off for Grok | 6 |
| Grok MCP Settings discovery | 7 |
| Keep ACP `mcpServers: []` unless injecting | 7 note |
| Codex restoreTaskLists when meaningful | 8 |
| No fake steer/rewind | non-goal (no task) |
| No fx/Hermes first-class | Task 1 registers only three |

## Self-review notes

- Model IDs stay source-native; target `fromHandoffPrefs` drops unknowns — matches spec.
- Cross-provider `providerAccountId` never applied — matches spec.
- Placeholders avoided; Task 8 is an explicit decision gate with both outcomes spelled out.
- `continueTarget` retained as primary default so single-button callers and labels keep working during the picker rollout.
