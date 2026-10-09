import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "../../features/sessions/model/session";
import { nativeModelId, resolveModel } from "../../features/sessions/model/models";
import { useCachedRateLimits } from "../../features/providers/model/rateLimitsCache";
import { ExternalLink } from "../../shared/ui/icons";
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

export function StatusLine({ line }: { line: string }) {
  const runs = useMemo(() => parseAnsi(line), [line]);
  return (
    <span className="truncate whitespace-pre" style={{ fontFamily: NERD_FONTS }}>
      {runs.map((run, i) => (
        <span key={i} style={runStyle(run)}>
          {run.text}
        </span>
      ))}
    </span>
  );
}

/**
 * Fork feature: under the composer, the person's own Claude Code status line
 * (model, effort, context, limits, cost ...) and the session's artifact links.
 */
export function StatusStrip({
  session,
  visible,
}: {
  session: Session;
  visible: boolean;
}) {
  const claude = session.harness === "claude";
  const limits = useCachedRateLimits("claude", session.providerAccountId ?? "default");
  const [line, setLine] = useState<string | null>(null);
  const latest = useRef(0);

  const input = useMemo(() => {
    if (!claude) return null;
    const model = resolveModel(session.harness, session.model);
    return JSON.stringify(
      buildStatusInput(
        session,
        { id: nativeModelId(session.model), name: model.name },
        limits,
      ),
    );
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

  const links = useMemo(
    () => artifactLinks(session.blocks).slice(0, MAX_LINKS),
    [session.blocks],
  );

  if (!claude || (!line && links.length === 0)) return null;
  return (
    <div
      data-fork-statusline
      className="flex min-w-0 items-center gap-3 px-3 pb-1.5 pt-1 font-mono text-[11px] leading-4 text-content/55"
    >
      {line ? <StatusLine line={line} /> : <span className="flex-1" />}
      {links.length > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {links.map((url) => (
            <button
              key={url}
              type="button"
              title={url}
              onClick={() => void openUrl(url).catch(() => undefined)}
              className="flex items-center gap-1 rounded-full bg-content/7 px-2 py-0.5 text-[10px] text-content/60 hover:bg-content/12 hover:text-content/85"
            >
              <ExternalLink className="size-3" strokeWidth={2} />
              {artifactLabel(url)}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
