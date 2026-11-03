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
