import {
  clampUsedPercent,
  formatResetDuration,
  formatUsagePercent,
  formatWindowLabel,
  type RateLimitWindow,
} from "../../features/providers/model/rateLimits";
import type { ProviderAccount } from "../../features/providers/model/providerAccounts";
import { barClass } from "../../features/providers/ui/ProviderAccountUsage";

/**
 * Fork feature: the footer names the default Claude login after its config
 * dir, as the person's status line does (~/.claude is "main"), instead of
 * "Default account".
 */
export function footerAccountLabel(account: ProviderAccount): string {
  if (
    account.isDefault &&
    account.provider === "claude" &&
    account.label === "Default account"
  ) {
    return "main";
  }
  return account.label;
}

/**
 * Fork feature: each usage window as "5h ▬ 4h 48m", a small bar of how much
 * is used (or left) in place of the percentage, which stays in the tooltip
 * and for screen readers.
 */
export function FooterUsage({
  windows,
  now,
  showRemaining,
}: {
  windows: { key: string; window: RateLimitWindow }[];
  now: number;
  showRemaining: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
      {windows.map(({ key, window }, index) => {
        const used = clampUsedPercent(window.usedPercent);
        return (
          <span key={key} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-content/25">·</span> : null}
            <span className="text-content/45">
              {formatWindowLabel(window.windowMinutes)}
            </span>
            <span className="sr-only">
              {formatUsagePercent(showRemaining ? 100 - used : used)}
            </span>
            <span
              className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10"
              aria-hidden
            >
              <span
                className={`block h-full rounded-full ${barClass(used)}`}
                style={{ width: `${showRemaining ? 100 - used : used}%` }}
              />
            </span>
            {window.resetsAt != null ? (
              <span>{formatResetDuration(window.resetsAt - now)}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
