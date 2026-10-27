import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  clampUsedPercent,
  formatResetDuration,
  formatWindowLabel,
  type ProviderRateLimits,
} from "../../features/providers/model/rateLimits";
import {
  loadRateLimits,
  useCachedRateLimits,
} from "../../features/providers/model/rateLimitsCache";
import {
  providerAccounts,
  subscribeProviderAccounts,
  type ProviderAccount,
} from "../../features/providers/model/providerAccounts";
import { barClass } from "../../features/providers/ui/ProviderAccountUsage";
import { useShowRemainingUsage } from "../../features/settings/model/displayPrefs";
import type { HarnessId } from "../../features/sessions/model/session";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { Gauge, RefreshCw } from "../../shared/ui/icons";
import { Popover, type PopoverDismissReason } from "../../shared/ui/Popover";
import { footerAccountLabel } from "./FooterUsage";
import {
  loadExtraUsage,
  useExtraUsage,
  type ExtraUsage,
  type ExtraUsageProvider,
  type UsageBar,
} from "./extraUsage";

const EXTRA: {
  provider: ExtraUsageProvider;
  name: string;
  harness?: HarnessId;
}[] = [
  { provider: "antigravity", name: "Antigravity", harness: "antigravity" },
  { provider: "muse", name: "Muse" },
  { provider: "deepseek", name: "DeepSeek", harness: "deepseek" },
];

/**
 * Fork feature: one footer button that lists every account's usage at once:
 * each Claude and Codex account, Antigravity and Muse windows, DeepSeek's
 * balance, and a note for Grok, which reports no plan usage.
 */
export function AllUsageChip({ className }: { className: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dismiss = (reason: PopoverDismissReason) => {
    setOpen(false);
    if (reason === "escape") {
      requestAnimationFrame(() => trigger.current?.focus());
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label="Usage on every account"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Usage on every account"
        onClick={() => setOpen((value) => !value)}
      >
        <Gauge className="size-3 shrink-0" />
        <span>All</span>
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="top"
          align="start"
          gap={7}
          width={340}
          maxHeight={520}
          autoFocus
          onDismiss={dismiss}
          role="dialog"
          aria-label="Usage on every account"
          className="overflow-y-auto p-3 font-sans text-[11px] text-content"
        >
          <AllUsagePanel />
        </Popover>
      ) : null}
    </>
  );
}

function useAccounts(provider: "claude" | "codex"): ProviderAccount[] {
  const snapshot = useSyncExternalStore(
    subscribeProviderAccounts,
    () => JSON.stringify(providerAccounts(provider)),
    () => "[]",
  );
  return JSON.parse(snapshot) as ProviderAccount[];
}

export function AllUsagePanel() {
  const claude = useAccounts("claude");
  const codex = useAccounts("codex");
  const [now, setNow] = useState(Date.now);
  const refresh = (force: boolean) => {
    setNow(Date.now());
    for (const account of claude) {
      void loadRateLimits("claude", account.id, force);
    }
    for (const account of codex) {
      void loadRateLimits("codex", account.id, force);
    }
    for (const { provider } of EXTRA) void loadExtraUsage(provider, force);
  };
  // Read on open and when an account is added; cached answers keep this cheap.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const accountKey = [...claude, ...codex]
    .map((account) => `${account.provider}:${account.id}`)
    .join(",");
  useEffect(() => refreshRef.current(false), [accountKey]);
  // Keep the reset countdowns moving while the panel stays open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[12px] font-medium">Usage on every account</h2>
        <button
          type="button"
          aria-label="Refresh all usage"
          title="Refresh all usage"
          onClick={() => refresh(true)}
          className="grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <Section name="Claude Code" harness="claude">
        {claude.map((account) => (
          <PlanRow
            key={account.id}
            provider="claude"
            account={account}
            now={now}
          />
        ))}
      </Section>
      <Section name="Codex" harness="codex">
        {codex.map((account) => (
          <PlanRow
            key={account.id}
            provider="codex"
            account={account}
            now={now}
          />
        ))}
      </Section>
      {EXTRA.map(({ provider, name, harness }) => (
        <ExtraSection
          key={provider}
          provider={provider}
          name={name}
          harness={harness}
          now={now}
        />
      ))}
      <Section name="Grok" harness="grok">
        <p className="text-content/45">Grok Build doesn't report plan usage.</p>
      </Section>
    </div>
  );
}

function Section({
  name,
  harness,
  children,
}: {
  name: string;
  harness?: HarnessId;
  children: ReactNode;
}) {
  return (
    <section aria-label={name} className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-content/40">
        {harness ? (
          <HarnessIcon harness={harness} className="size-3 shrink-0" />
        ) : (
          <Gauge className="size-3 shrink-0" />
        )}
        {name}
      </h3>
      {children}
    </section>
  );
}

function windowsOf(limits: ProviderRateLimits): UsageBar[] {
  return [limits.session, limits.weekly, limits.monthly].flatMap((window) =>
    window
      ? [
          {
            label: formatWindowLabel(window.windowMinutes),
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
          },
        ]
      : [],
  );
}

function PlanRow({
  provider,
  account,
  now,
}: {
  provider: "claude" | "codex";
  account: ProviderAccount;
  now: number;
}) {
  const limits = useCachedRateLimits(provider, account.id);
  const bars = windowsOf(limits);
  return (
    <Row label={footerAccountLabel(account)}>
      {bars.length > 0 ? (
        <Bars bars={bars} now={now} />
      ) : (
        <Note>
          {limits.status === "idle" || limits.status === "fetching"
            ? "Loading…"
            : (limits.error ?? "No usage reported")}
        </Note>
      )}
    </Row>
  );
}

function ExtraSection({
  provider,
  name,
  harness,
  now,
}: {
  provider: ExtraUsageProvider;
  name: string;
  harness?: HarnessId;
  now: number;
}) {
  const usage = useExtraUsage(provider);
  return (
    <Section name={name} harness={harness}>
      <ExtraRows usage={usage} now={now} />
    </Section>
  );
}

function ExtraRows({ usage, now }: { usage: ExtraUsage; now: number }) {
  if ("message" in usage) return <Note>{usage.message}</Note>;
  if (usage.status !== "ok") return <Note>Loading…</Note>;
  const groups = new Map<string, UsageBar[]>();
  for (const bar of usage.bars) {
    const key = bar.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), bar]);
  }
  return (
    <>
      {usage.detail ? (
        <p className="truncate text-content/70">{usage.detail}</p>
      ) : null}
      {[...groups].map(([group, bars]) => (
        <Row key={group} label={group || "Plan"}>
          <Bars bars={bars} now={now} />
        </Row>
      ))}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-24 shrink-0 truncate text-content/70" title={label}>
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <span className="block truncate text-content/40">{children}</span>;
}

/** A bar per window, filled by what is used (or left, per the display setting). */
function Bars({ bars, now }: { bars: UsageBar[]; now: number }) {
  const showRemaining = useShowRemainingUsage();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 tabular-nums">
      {bars.map((bar) => {
        const used = clampUsedPercent(bar.usedPercent);
        const shown = showRemaining ? 100 - used : used;
        return (
          <span
            key={bar.label}
            className="inline-flex items-center gap-1"
            title={`${Math.round(shown)}% ${showRemaining ? "left" : "used"}`}
          >
            <span className="text-content/45">{bar.label}</span>
            <span className="sr-only">
              {Math.round(shown)}% {showRemaining ? "left" : "used"}
            </span>
            <span
              className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-content/10"
              aria-hidden
            >
              <span
                className={`block h-full rounded-full ${barClass(used)}`}
                style={{ width: `${shown}%` }}
              />
            </span>
            {bar.resetsAt != null && bar.resetsAt > now ? (
              <span className="text-content/55">
                {formatResetDuration(bar.resetsAt - now)}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
