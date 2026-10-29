import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  harnessIdleSince,
  parkIdleHarnessSession,
} from "../../integrations/harness/core/registry";
import {
  sessionDisplayTitle,
  sessionNeedsInput,
  type Session,
} from "../../features/sessions/model/session";
import { Gauge } from "../../shared/ui/icons";
import { LAYER } from "../../shared/lib/layers";
import { Popover } from "../../shared/ui/Popover";
import {
  autoParkStep,
  buildRows,
  formatBytes,
  parseReport,
  suggestParks,
  totalSessionBytes,
  type AutoParkState,
  type MemoryReport,
  type MemoryRow,
  type SessionFacts,
} from "./memoryModel";
import {
  markParked,
  memorySettings,
  pruneParked,
  useParkedSessions,
} from "./memoryStore";
import { MemoryPanel, PRESSURE_DOT } from "./MemoryPanel";

const POLL_OPEN_MS = 4_000;
const POLL_CLOSED_MS = 15_000;
const NOTICE_MS = 10_000;

type Props = {
  sessions: RefObject<Session[]>;
  /** The conversation on screen is never parked. */
  isForeground: (sessionId: string) => boolean;
  /** The footer's slot, shared with the high-usage chip. */
  chipHost?: HTMLElement | null;
  insetChip?: boolean;
};

function sessionFacts(
  sessions: readonly Session[],
  isForeground: (sessionId: string) => boolean,
): Map<string, SessionFacts> {
  return new Map(
    sessions.map((session) => [
      session.id,
      {
        id: session.id,
        title: sessionDisplayTitle(session.title, session.harness),
        busy: session.busy === true,
        needsInput: sessionNeedsInput(session),
        foreground: isForeground(session.id),
        idleSince: harnessIdleSince(session.id),
      },
    ]),
  );
}

/**
 * Fork: the footer's "Memory" chip. Shows how tight memory is and how much
 * RAM the sessions' agents hold; its popover parks idle ones. With the
 * setting on, sustained pressure parks the suggested ones by itself.
 */
export function MemoryWatcher({
  sessions,
  isForeground,
  chipHost,
  insetChip = false,
}: Props) {
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [parking, setParking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ titles: string[]; freed: number }>();
  const parked = useParkedSessions();
  const anchor = useRef<HTMLButtonElement>(null);
  const auto = useRef<AutoParkState>({});
  const foreground = useRef(isForeground);
  foreground.current = isForeground;
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  /** Re-check one session against fresh facts, then park it. */
  const park = useCallback(
    async (targets: readonly MemoryRow[]): Promise<MemoryRow[]> => {
      const done: MemoryRow[] = [];
      setParking((previous) => new Set([...previous, ...targets.map((row) => row.sessionId)]));
      try {
        for (const row of targets) {
          const facts = sessionFacts(sessions.current ?? [], foreground.current);
          const fresh = buildRows(
            { pressure: "normal", totalBytes: 0, availableBytes: 0, sessions: [row] },
            facts,
            Date.now(),
          )[0];
          if (!fresh?.parkable) {
            continue;
          }
          if (await parkIdleHarnessSession(row.sessionId)) {
            markParked({
              sessionId: row.sessionId,
              title: fresh.title,
              freedBytes: row.rssBytes,
              parkedAt: Date.now(),
            });
            done.push(row);
          }
        }
      } catch (cause) {
        setError(String(cause));
      } finally {
        setParking((previous) => {
          const next = new Set(previous);
          for (const row of targets) {
            next.delete(row.sessionId);
          }
          return next;
        });
        void refreshRef.current();
      }
      return done;
    },
    [sessions],
  );

  const refresh = useCallback(async () => {
    try {
      const next = parseReport(await invoke<unknown>("fork_memory_report"));
      if (!next) {
        return;
      }
      const list = sessions.current ?? [];
      const nextRows = buildRows(next, sessionFacts(list, foreground.current), Date.now());
      pruneParked(
        new Set(next.sessions.map((entry) => entry.sessionId)),
        new Set(list.filter((session) => !session.busy).map((session) => session.id)),
      );
      setReport(next);
      setRows(nextRows);
      setError("");
      const settings = memorySettings();
      const step = autoParkStep(auto.current, {
        enabled: settings.autoPark,
        report: next,
        rows: nextRows,
        idleThresholdMs: settings.idleMinutes * 60_000,
        now: Date.now(),
      });
      auto.current = step.state;
      if (step.park.length > 0) {
        const done = await park(step.park);
        if (done.length > 0) {
          setNotice({
            titles: done.map((row) => row.title),
            freed: totalSessionBytes(done),
          });
        }
      }
    } catch (cause) {
      setError(String(cause));
    }
  }, [sessions, park]);
  refreshRef.current = refresh;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (!document.hidden) {
        await refreshRef.current();
      }
      if (alive) {
        timer = window.setTimeout(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!chipHost) {
      setOpen(false);
    }
  }, [chipHost]);

  if (!report) {
    return null;
  }
  const total = totalSessionBytes(rows);
  const suggestion = suggestParks(rows, report);
  const openParked = [...parked.values()].filter((entry) =>
    (sessions.current ?? []).some((session) => session.id === entry.sessionId),
  );
  const label = `Memory${total > 0 ? ` · ${formatBytes(total)}` : ""}`;
  const pressureWord =
    report.pressure === "critical"
      ? "Memory is very tight"
      : report.pressure === "warn"
        ? "Memory is getting tight"
        : "Memory is fine";

  return (
    <>
      {chipHost
        ? createPortal(
            <button
              ref={anchor}
              type="button"
              data-fork-memory=""
              aria-haspopup="dialog"
              aria-expanded={open}
              title={`${pressureWord} · sessions use ${formatBytes(total)}`}
              onClick={() => setOpen(!open)}
              className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap ${insetChip ? "rounded-full px-2" : "rounded-md px-1.5"} transition-colors hover:bg-content/8 hover:text-content focus-visible:outline-2 focus-visible:outline-accent ${
                open ? "bg-content/8 text-content" : "text-content/55"
              }`}
            >
              <Gauge className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="tabular-nums">{label}</span>
              <span
                className={`size-1.5 shrink-0 rounded-full ${PRESSURE_DOT[report.pressure]}`}
                aria-hidden
              />
            </button>,
            chipHost,
          )
        : null}
      {open && chipHost ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={360}
          ignore="[data-fork-memory]"
          onDismiss={() => setOpen(false)}
        >
          <MemoryPanel
            report={report}
            rows={rows}
            suggestion={suggestion}
            parked={openParked}
            parking={parking}
            error={error}
            onPark={(row) => void park([row])}
            onParkSuggested={() => void park(suggestion.rows)}
          />
        </Popover>
      ) : null}
      {notice
        ? createPortal(
            <div
              role="status"
              style={{ zIndex: LAYER.toast }}
              className="fixed right-3 bottom-10 max-w-[320px] rounded-xl bg-background-base/95 px-3 py-2 text-[12px] text-content/70 shadow-lg ring-1 ring-content/10"
            >
              <p className="font-medium text-content">
                Parked {notice.titles.length} idle{" "}
                {notice.titles.length === 1 ? "session" : "sessions"} · frees ~
                {formatBytes(notice.freed)}
              </p>
              <p className="mt-0.5 truncate text-content/55" title={notice.titles.join(", ")}>
                {notice.titles.join(", ")}
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
