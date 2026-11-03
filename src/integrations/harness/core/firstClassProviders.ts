import type { HarnessId, RuntimeMode } from "../../../features/sessions/model/session";

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
    fromHandoffPrefs: (prefs, helpers) =>
      mapIncomingPrefs("claude", prefs, helpers),
  },
  {
    id: "codex",
    accounts: "profiles",
    usage: "supported",
    mcpDiscovery: true,
    cliUpdates: true,
    handoff: true,
    // Codex maps turn/plan/updated to full tasks.updated snapshots (no per-id
    // TaskUpdate map like Claude's tasksByThread), so resume needs no seed.
    restoreTaskLists: false,
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
    fromHandoffPrefs: (prefs, helpers) =>
      mapIncomingPrefs("grok", prefs, helpers),
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
  return PROFILES.filter(
    (profile) => profile.handoff && profile.id !== from,
  ).map((profile) => profile.id);
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
