import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "../../features/sessions/model/session";
import {
  nativeModelId,
  resolveModel,
} from "../../features/sessions/model/models";
import { useCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import type { ProviderRateLimits } from "../../features/providers/model/rateLimits";
import { useShowRemainingUsage } from "../../features/settings/model/displayPrefs";
import { ExternalLink } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { parseAnsi, type AnsiRun } from "./ansi";
import {
  artifactLabel,
  artifactLinks,
  buildStatusInput,
  parseStatusData,
  usageFacts,
  type StatusData,
  type UsageFact,
} from "./statusInput";

const REFRESH_MS = 30_000;
const MAX_LINKS = 6;
// Status lines use Nerd Font icons; the app's own mono font has none.
const NERD_FONTS =
  '"JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, monospace';

// OpenCode's default theme (light / dark), which the owner prefers to a
// terminal-style line.
export const OC = {
  primary: "text-[#3b7dd8] dark:text-[#fab283]",
  accent: "text-[#7b5bb6] dark:text-[#9d7cd8]",
  info: "text-[#318795] dark:text-[#56b6c2]",
  warning: "text-[#d68c27] dark:text-[#f5a742]",
  error: "text-[#d1383d] dark:text-[#e06c75]",
  text: "text-[#1a1a1a] dark:text-[#eeeeee]",
  muted: "text-[#8a8a8a] dark:text-[#808080]",
};

function runStyle(run: AnsiRun): React.CSSProperties {
  const { color, background, bold, dim, italic } = run.style;
  return {
    ...(color ? { color } : {}),
    ...(background ? { background } : {}),
    ...(bold ? { fontWeight: 600 } : {}),
    ...(dim ? { opacity: 0.6 } : {}),
    ...(italic ? { fontStyle: "italic" } : {}),
  };
}

/** An older status script's ANSI line, drawn as the terminal would. */
export function StatusLine({
  line,
  ref,
}: {
  line: string;
  ref?: React.Ref<HTMLSpanElement>;
}) {
  const runs = useMemo(() => parseAnsi(line), [line]);
  return (
    <span
      ref={ref}
      className="min-w-0 truncate whitespace-pre"
      style={{ fontFamily: NERD_FONTS }}
    >
      {runs.map((run, i) => (
        <span key={i} style={runStyle(run)}>
          {run.text}
        </span>
      ))}
    </span>
  );
}

export type SessionStatus = {
  /** The composer layout's data; null until it arrives or from an older script. */
  data: StatusData | null;
  /** The script's raw output, drawn as ANSI when it is not data. */
  line: string | null;
  links: string[];
  limits: ProviderRateLimits;
};

/**
 * Fork feature: runs the person's own Claude Code status script for a
 * session and gathers what the composer shows around it. Null for other
 * harnesses.
 */
export function useSessionStatus(
  session: Session,
  visible: boolean,
): SessionStatus | null {
  const claude = session.harness === "claude";
  const limits = useCachedRateLimits(
    "claude",
    session.providerAccountId ?? "default",
  );
  const [line, setLine] = useState<string | null>(null);
  const data = useMemo(() => (line ? parseStatusData(line) : null), [line]);
  const latest = useRef(0);

  const input = useMemo(() => {
    if (!claude) return null;
    const model = resolveModel(session.harness, session.model);
    return JSON.stringify({
      ...buildStatusInput(
        session,
        { id: nativeModelId(session.model), name: model.name },
        limits,
      ),
      // Model, effort, branch, context and limits are already on screen.
      layout: "composer",
    });
    // Only the fields the status line reads; the whole session changes on every token.
  }, [
    claude,
    session.harness,
    session.model,
    session.cwd,
    session.worktreeCwd,
    session.providerSessionId,
    session.modelSettings,
    session.context,
    limits,
  ]);
  const busy = !!session.busy;

  useEffect(() => {
    if (!input || !visible) return;
    const cwd = session.worktreeCwd || session.cwd;
    let cancelled = false;
    const refresh = () => {
      // Only the newest call may set the line, so a slow older run can't win.
      const call = ++latest.current;
      invoke<string | null>("fork_statusline", { cwd, input })
        .then((next) => {
          if (!cancelled && call === latest.current) setLine(next ?? null);
        })
        .catch(() => {
          // Keep the last good line; a slow or broken script must not blank it.
        });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `busy` refreshes when a turn starts and ends.
  }, [input, visible, busy, session.cwd, session.worktreeCwd]);

  // Keyed by content: `blocks` changes on every streamed token.
  const linkKey = useMemo(
    () => artifactLinks(session.blocks).slice(0, MAX_LINKS).join("\n"),
    [session.blocks],
  );
  const links = useMemo(() => (linkKey ? linkKey.split("\n") : []), [linkKey]);

  return useMemo(
    () => (claude ? { data, line, links, limits } : null),
    [claude, data, line, links, limits],
  );
}

/** Which Claude Code account runs the session; top left of the composer. */
export function AccountTag({ account }: { account?: string }) {
  if (!account) return null;
  return (
    <span
      title={`Claude Code account: ${account}`}
      className={`shrink-0 font-mono text-[11px] font-semibold ${OC.primary}`}
    >
      {account}
    </span>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function usageTone(used: number): string {
  if (used >= 90) return OC.error;
  if (used >= 70) return OC.warning;
  return OC.text;
}

type Fact = {
  key: string;
  value: string;
  label: string;
  suffix?: string;
  tone: string;
  title: string;
};

function factsFor(
  data: StatusData | null,
  usage: UsageFact[],
  showRemaining: boolean,
): Fact[] {
  const facts: Fact[] = usage.map((window) => ({
    key: window.key,
    value: `${window.percent}%`,
    label: window.label,
    ...(window.resetsIn ? { suffix: window.resetsIn } : {}),
    tone: usageTone(window.used),
    title: `${window.key === "session" ? "5-hour" : "Weekly"} limit: ${window.percent}% ${
      showRemaining ? "left" : "used"
    }${window.resetsIn ? `, resets in ${window.resetsIn}` : ""}`,
  }));
  if (data && data.claims > 0) {
    facts.push({
      key: "claims",
      value: String(data.claims),
      label: plural(data.claims, "file locked", "files locked"),
      tone: OC.accent,
      title:
        "Files this session is editing. Other sessions are kept off them until it ends.",
    });
  }
  if (data && data.memories > 0) {
    facts.push({
      key: "memories",
      value: String(data.memories),
      label: plural(data.memories, "memory", "memories"),
      tone: OC.info,
      title: "Saved memories pulled into this session for your last message.",
    });
  }
  return facts;
}

export function StatusFacts({
  data,
  usage = [],
  showRemaining = false,
  ref,
}: {
  data: StatusData | null;
  usage?: UsageFact[];
  showRemaining?: boolean;
  ref?: React.Ref<HTMLSpanElement>;
}) {
  const facts = factsFor(data, usage, showRemaining);
  if (facts.length === 0) return null;
  return (
    <span
      ref={ref}
      className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap"
    >
      {facts.map((fact) => (
        <span key={fact.key} title={fact.title}>
          {usage.some((window) => window.key === fact.key) ? (
            <>
              <span className={OC.muted}>{fact.label}</span>{" "}
              <span className={fact.tone}>{fact.value}</span>
              {fact.suffix ? (
                <span className={OC.muted}> {fact.suffix}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className={fact.tone}>{fact.value}</span>{" "}
              <span className={OC.muted}>{fact.label}</span>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * Fork feature: the composer's bottom row details. Usage limits, locked
 * files and recalled memories, then the session's artifact links.
 */
export function StatusExtras({ status }: { status: SessionStatus }) {
  const { data, line, links, limits } = status;
  const showRemaining = useShowRemainingUsage();
  // Re-read the clock with the limits; the script refresh re-renders too.
  const usage = useMemo(
    () => usageFacts(limits, showRemaining, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [limits, showRemaining, line],
  );

  // The details have priority: when the chips would squeeze them, they
  // fold into one "N links" chip that opens a menu.
  const strip = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLSpanElement>(null);
  const fullChips = useRef<HTMLSpanElement>(null);
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const chips = fullChips.current?.offsetWidth ?? 0;
      const text = details.current?.scrollWidth ?? 0;
      const room =
        el.clientWidth - parseFloat(getComputedStyle(el).columnGap || "0");
      setFolded(chips > 0 && text + chips > room);
    };
    measure();
    let live = true;
    // The font can land after the first measure and widen the text.
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [line, links, usage]);

  // An older script sends an ANSI line instead of data; show it as it is.
  const legacy = !data && line;
  if (!legacy && usage.length === 0 && !data && links.length === 0) {
    return null;
  }
  const chips = links.map((url) => <LinkChip key={url} url={url} />);
  return (
    <div
      ref={strip}
      data-fork-statusline
      className="relative flex min-w-0 flex-1 items-center justify-end gap-3 overflow-hidden pl-2 font-mono text-[11px] leading-4"
    >
      {legacy ? (
        <StatusLine line={line} ref={details} />
      ) : (
        <StatusFacts
          data={data}
          usage={usage}
          showRemaining={showRemaining}
          ref={details}
        />
      )}
      {links.length > 0 ? (
        <>
          {/* Off-screen copy, measured to decide whether the chips fit. */}
          <span
            ref={fullChips}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1"
          >
            {chips}
          </span>
          {folded ? (
            <LinksMenu links={links} />
          ) : (
            <span className="flex shrink-0 items-center gap-1">{chips}</span>
          )}
        </>
      ) : null}
    </div>
  );
}

const CHIP =
  "flex items-center gap-1 whitespace-nowrap rounded-full bg-content/7 px-2 py-0.5 text-[10px] text-content/60 hover:bg-content/12 hover:text-content/85";

function openLink(url: string) {
  void openUrl(url).catch(() => undefined);
}

function LinkChip({ url }: { url: string }) {
  return (
    <button
      type="button"
      title={url}
      onClick={() => openLink(url)}
      className={CHIP}
    >
      <ExternalLink className="size-3" strokeWidth={2} />
      {artifactLabel(url)}
    </button>
  );
}

function LinksMenu({ links }: { links: string[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Artifact links"
        onClick={() => setMenuOpen((value) => !value)}
        className={`shrink-0 ${CHIP}`}
      >
        <ExternalLink className="size-3" strokeWidth={2} />
        {links.length} {links.length === 1 ? "link" : "links"}
      </button>
      {menuOpen ? (
        <Popover
          anchor={trigger}
          side="top"
          align="end"
          autoFocus
          onDismiss={() => setMenuOpen(false)}
          role="menu"
          aria-label="Artifact links"
          className="min-w-[14rem] p-1"
        >
          {links.map((url) => (
            <button
              key={url}
              type="button"
              role="menuitem"
              title={url}
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left font-mono text-[12px] leading-none text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setMenuOpen(false);
                openLink(url);
              }}
            >
              <ExternalLink className="size-3 shrink-0" strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate">
                {artifactLabel(url)}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
