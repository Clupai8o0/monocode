import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  artifactLabel,
  getArtifact,
  type ArtifactCard,
} from "../../features/artifacts/artifacts";
import { ArtifactIcon } from "../../features/artifacts/ui/ArtifactCard";
import type { MonoLook, MonoState } from "../../features/monos/model/mono";
import {
  habitRunningSince,
  habitScheduleLabel,
  subscribeHabitsRunning,
  type Habit,
} from "../../features/monos/model/monoHabits";
import { PixelMascot } from "../../features/projects/ui/PixelMascot";
import type {
  MonoSpawnedSession,
  Session,
} from "../../features/sessions/model/session";
import { formatInteger } from "../../shared/lib/numbers";
import { Clock } from "../../shared/ui/icons";
import { ContributionCalendar } from "./ContributionCalendar";
import {
  dayCount,
  dayKey,
  daysFrom,
  habitsRunToday,
  habitWhen,
  mergedOn,
  monoTicker,
  shortSpan,
  streak,
  upcomingHabits,
} from "./dashboardModel";
import { useMonoContributions } from "./useMonoContributions";

/** How often the numbers that depend on the clock are worked out again. */
const CLOCK_MS = 60_000;
/** Documents looked at for "New today", newest first. */
const DOCUMENTS_CHECKED = 30;
const NEW_TODAY_SHOWN = 4;

/** When each document was written; a saved document's date never changes. */
const documentDates = new Map<string, number>();

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="px-1 text-[11px] font-medium text-content/40">{title}</h3>
      {children}
    </section>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-0.5 rounded-lg bg-content/4 px-3 py-2.5">
      <div className="truncate text-[20px] font-semibold leading-[26px] tabular-nums text-content/95">
        {children}
      </div>
      <div className="truncate text-[11px] text-content/45">{label}</div>
    </div>
  );
}

function Row({
  icon,
  title,
  detail,
  aside,
  asideClassName = "text-content/40",
  onClick,
  ...data
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  aside?: ReactNode;
  asideClassName?: string;
  onClick: () => void;
  "data-mono-dashboard-habit"?: string;
  "data-mono-dashboard-document"?: string;
}) {
  return (
    <button
      type="button"
      {...data}
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-content/5"
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-md bg-content/6 text-content/60"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] leading-5 text-content/85">
          {title}
        </span>
        {detail ? (
          <span className="truncate text-[11px] leading-4 text-content/45">
            {detail}
          </span>
        ) : null}
      </span>
      {aside ? (
        <span className={`shrink-0 text-[11px] tabular-nums ${asideClassName}`}>
          {aside}
        </span>
      ) : null}
    </button>
  );
}

/** Each document's date, read once. Documents still loading are left out. */
function useDocumentDates(documents: readonly ArtifactCard[]) {
  const [, setRead] = useState(0);
  const newest = useMemo(
    () => documents.slice(-DOCUMENTS_CHECKED).map((card) => card.id),
    [documents],
  );
  const key = newest.join("\u0000");
  useEffect(() => {
    let live = true;
    const missing = newest.filter((id) => !documentDates.has(id));
    if (!missing.length) return;
    void Promise.allSettled(
      missing.map(async (id) => {
        const artifact = await getArtifact(id);
        if (artifact) documentDates.set(id, artifact.createdAt);
      }),
    ).then(() => {
      if (live) setRead((count) => count + 1);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return documentDates;
}

/**
 * The Mono at a glance: what it is doing, its code contributions, today's
 * numbers, what runs next and what it wrote today.
 */
export function MonoDashboard({
  monoId,
  agent,
  state,
  active,
  sessionIds,
  launches,
  sessions,
  habits,
  documents,
  onOpenHabit,
  onOpenDocument,
}: {
  monoId: string;
  agent: MonoLook;
  state: MonoState;
  /** The tab and panel are showing, so its numbers are worth reading. */
  active: boolean;
  /** Its conversations and every session it started. */
  sessionIds: readonly string[];
  launches: readonly MonoSpawnedSession[];
  sessions: readonly Session[];
  habits: readonly Habit[] | undefined;
  documents: readonly ArtifactCard[];
  onOpenHabit: (id: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // Re-render when a habit starts or stops; the list itself reads the store.
  useSyncExternalStore(subscribeHabitsRunning, () =>
    (habits ?? []).map((habit) => habitRunningSince(habit.id) ?? 0).join(),
  );

  const { data, failed } = useMonoContributions(monoId, sessionIds, active);
  const dates = useDocumentDates(documents);
  const today = dayKey(now);

  const items = useMemo(() => data?.contributions ?? [], [data]);
  const days = useMemo(() => daysFrom(items, now), [items, now]);
  const total = days.reduce((sum, day) => sum + dayCount(day), 0);
  const running = streak(days);
  const todayStats = days[days.length - 1];

  const launchedIds = new Set(launches.map((launch) => launch.sessionId));
  const busy = sessions.filter(
    (entry) => entry.busy && launchedIds.has(entry.id),
  );
  const launchedSaved = (data?.sessions ?? []).filter((entry) =>
    launchedIds.has(entry.id),
  );
  const lastActive = launchedSaved.reduce<number | undefined>(
    (latest, entry) => Math.max(latest ?? 0, entry.updatedAt),
    undefined,
  );
  const ticker = monoTicker({
    status: state.status,
    activity: state.activity,
    busyTitles: busy.map((entry) => entry.title),
    lastActive,
    now,
  });
  const status =
    state.status === "idle" && busy.length ? "working" : state.status;

  // A busy session may not have saved yet today, so it counts as well.
  const sessionsToday = new Set([
    ...launchedSaved
      .filter((entry) => dayKey(entry.updatedAt) === today)
      .map((entry) => entry.id),
    ...busy.map((entry) => entry.id),
  ]).size;
  const habitRuns = habitsRunToday(habits ?? [], now);
  const upcoming = upcomingHabits(habits ?? [], habitRunningSince);

  const newToday = documents
    .filter((card) => {
      const at = dates.get(card.id);
      return at != null && dayKey(at) === today;
    })
    .sort((a, b) => (dates.get(b.id) ?? 0) - (dates.get(a.id) ?? 0))
    .slice(0, NEW_TODAY_SHOWN);

  const needsYou = status === "needs-you";
  return (
    <div className="flex min-w-0 flex-col gap-6 pb-4" data-mono-dashboard>
      <header className="flex min-w-0 items-center gap-3 px-1 pt-1">
        <span className="grid size-12 shrink-0 place-items-center">
          <PixelMascot
            name={agent.mascot}
            color={agent.color}
            status={status}
            className="size-11 shrink-0"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-[15px] font-semibold leading-5 text-content">
            {agent.name}
          </h2>
          <p
            data-mono-dashboard-ticker
            title={ticker.text}
            className={`flex min-w-0 items-center gap-1.5 text-[12px] ${
              needsYou ? "text-accent" : "text-content/55"
            }`}
          >
            {ticker.live ? (
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  status === "working" ? "animate-pulse" : ""
                }`}
                style={{
                  background: needsYou ? "var(--color-accent)" : agent.color,
                }}
              />
            ) : null}
            <span className="min-w-0 truncate">{ticker.text}</span>
          </p>
        </div>
      </header>

      <Section title="Contributions">
        <div className="flex flex-wrap items-baseline gap-x-1.5 px-1">
          <span className="text-[13px] font-semibold tabular-nums text-content/90">
            {formatInteger(total)}
          </span>
          <span className="whitespace-nowrap text-[12px] text-content/50">
            in the last 6 months
          </span>
          {running > 1 ? (
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-content/50">
              {running}-day streak
            </span>
          ) : null}
        </div>
        <div className="px-1">
          <ContributionCalendar days={days} color={agent.color} />
        </div>
        {failed ? (
          <p role="alert" className="px-1 text-[11px] text-content/50">
            Couldn&apos;t read this Mono&apos;s contributions.
          </p>
        ) : !data ? (
          <p className="px-1 text-[11px] text-content/40">
            Reading its past sessions…
          </p>
        ) : null}
      </Section>

      <Section title="Today">
        {/* A narrow panel stacks them rather than cut a number off. */}
        <div className="flex flex-wrap gap-2">
          <Tile label="PRs merged">{mergedOn(items, today)}</Tile>
          <Tile label="Lines changed">
            <span className="text-diff-add-fg">
              +{formatInteger(todayStats.additions)}
            </span>{" "}
            <span className="text-diff-del-fg">
              −{formatInteger(todayStats.deletions)}
            </span>
          </Tile>
          <Tile label="Sessions">{sessionsToday}</Tile>
          <Tile label="Habits run">
            {habitRuns.ran}/{habitRuns.total}
          </Tile>
        </div>
      </Section>

      <Section title="Up next">
        {upcoming.length ? (
          <div className="flex flex-col gap-px">
            {upcoming.map((habit) => {
              const since = habitRunningSince(habit.id);
              return (
                <Row
                  key={habit.id}
                  data-mono-dashboard-habit={habit.id}
                  icon={
                    since != null ? (
                      <span
                        className="size-2 animate-pulse rounded-full"
                        style={{ background: agent.color }}
                      />
                    ) : (
                      <Clock className="size-3.5" strokeWidth={1.75} />
                    )
                  }
                  title={habit.name}
                  detail={habitScheduleLabel(habit.schedule)}
                  aside={
                    since != null
                      ? `Running · ${shortSpan(now - since)}`
                      : habitWhen(habit, now)
                  }
                  asideClassName={
                    since != null ? "text-content/70" : "text-content/40"
                  }
                  onClick={() => onOpenHabit(habit.id)}
                />
              );
            })}
          </div>
        ) : (
          <p className="px-1 text-[12px] leading-[18px] text-content/45">
            Nothing scheduled. Ask {agent.name} to put recurring work on a
            habit.
          </p>
        )}
      </Section>

      <Section title="New today">
        {newToday.length ? (
          <div className="flex flex-col gap-px">
            {newToday.map((card) => (
              <Row
                key={card.id}
                data-mono-dashboard-document={card.id}
                icon={<ArtifactIcon kind={card.kind} className="size-3.5" />}
                title={card.title}
                detail={card.summary?.trim() || artifactLabel(card.kind)}
                aside={shortSpan(now - (dates.get(card.id) ?? now))}
                onClick={() => onOpenDocument(card.id)}
              />
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-content/45">
            Nothing new yet today.
          </p>
        )}
      </Section>
    </div>
  );
}
