import { useSyncExternalStore } from "react";
import type { RateLimitProvider } from "../../features/providers/model/rateLimits";
import {
  getHarnessAvailabilitySnapshot,
  isHarnessAvailable,
  subscribeHarnessAvailability,
} from "../../integrations/harness/core/availabilityState";
import {
  getPickerVisibilitySnapshot,
  isPickerProviderVisible,
  subscribePickerVisibility,
} from "../../features/sessions/model/models";
import {
  isProviderHidden,
  projectProvidersRevision,
  subscribeProjectProviders,
} from "../../features/sessions/model/projectProviders";

/**
 * Keep both installed plan balances in view, regardless of which agent is
 * active. Reuse the app's discovery/settings stores; this starts no probes or
 * polls. The active provider remains visible for existing conversations even
 * when the user hides it from new-session choices.
 */
export function useFooterProviders(
  active: readonly RateLimitProvider[],
  project?: string,
): RateLimitProvider[] {
  useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  useSyncExternalStore(
    subscribeProjectProviders,
    projectProvidersRevision,
    projectProvidersRevision,
  );
  const providers = new Set<RateLimitProvider>();
  for (const provider of ["claude", "codex"] as const) {
    if (
      active.includes(provider) ||
      (isHarnessAvailable(provider) &&
        isPickerProviderVisible(provider) &&
        !isProviderHidden(project, provider))
    ) {
      providers.add(provider);
    }
  }
  active.forEach((provider) => providers.add(provider));
  return [...providers];
}
