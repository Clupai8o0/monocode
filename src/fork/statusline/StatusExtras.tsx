import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "../../features/sessions/model/session";
import {
  nativeModelId,
  resolveModel,
} from "../../features/sessions/model/models";
import { useCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import { ExternalLink } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { parseAnsi, type AnsiRun } from "./ansi";
import { artifactLabel, artifactLinks, buildStatusInput } from "./statusInput";

const REFRESH_MS = 30_000;
const MAX_LINKS = 6;
// Status lines use Nerd Font icons; the app's own mono font has none.
const NERD_FONTS =
  '"JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, monospace';

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

/**
 * Fork feature: in the composer's bottom row, the parts of the person's own
 * Claude Code status line the composer doesn't already show (account,
 * compactions, claims, memories ...) and the session's artifact links.
 */
export function StatusExtras({
  session,
  visible,
}: {
  session: Session;
  visible: boolean;
}) {
  const claude = session.harness === "claude";
  const limits = useCachedRateLimits(
    "claude",
    session.providerAccountId ?? "default",
  );
  const [line, setLine] = useState<string | null>(null);
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

  // The status line has priority: when the chips would squeeze it, they
  // fold into one "N links" chip that opens a menu.
  const strip = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const fullChips = useRef<HTMLSpanElement>(null);
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const chips = fullChips.current?.offsetWidth ?? 0;
      const text = status.current?.scrollWidth ?? 0;
      const style = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(style.columnGap || "0");
      setFolded(chips > 0 && text + chips > room);
    };
    measure();
    let live = true;
    // The Nerd Font can land after the first measure and widen the line.
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [line, links]);

  if (!claude || (!line && links.length === 0)) return null;
  const chips = links.map((url) => <LinkChip key={url} url={url} />);
  return (
    <div
      ref={strip}
      data-fork-statusline
      className="relative flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden pl-2 font-mono text-[11px] leading-4 text-content/55"
    >
      {line ? <StatusLine line={line} ref={status} /> : null}
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
