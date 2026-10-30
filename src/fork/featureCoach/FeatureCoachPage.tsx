import { useEffect, useMemo, useState } from "react";
import { listMonos } from "../../features/monos/model/mono";
import { loadHabits } from "../../features/monos/model/monoHabits";
import { prettyCwd, projectName } from "../../shared/lib/paths";
import { Check, Loader, Pin } from "../../shared/ui/icons";
import {
  coachCounts,
  coachHost,
  coachProgress,
  pinSuggestions,
  rankCoachCards,
  type CoachCard,
  type CoachCounts,
  type CoachFeatureId,
  type CoachSession,
} from "./featureCoach";
import { addHabitPreset, HABIT_PRESETS } from "./habitPresets";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** A progress ring. The track and arc are the only marks; the count sits inside. */
function Ring({
  progress,
  count,
  size,
}: {
  progress: number;
  count: number;
  size: number;
}) {
  const stroke = size >= 80 ? 7 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.14}
          strokeWidth={stroke}
        />
        {progress > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * progress} ${circumference}`}
            className={progress >= 1 ? "stroke-diff-add-fg" : "stroke-accent"}
          />
        ) : null}
      </svg>
      <span
        className={`absolute font-medium tabular-nums text-content ${
          size >= 80 ? "text-[26px] tracking-[-0.02em]" : "text-[12px]"
        }`}
      >
        {count}
      </span>
    </span>
  );
}

function runTry(id: CoachFeatureId) {
  const host = coachHost();
  if (!host) return;
  if (id === "worktrees") host.openSettings("worktrees");
  else if (id === "queue") host.openSettings("chat", "follow-up");
  else if (id === "quick-composer") host.openSettings("general", "quick-composer");
  else if (id === "orchestration") host.newSessionWith("/orchestrator ");
  else if (id === "split") host.split();
  else if (id === "palette") host.openPalette();
  else {
    document
      .getElementById(id === "pinned" ? "coach-pins" : "coach-habits")
      ?.scrollIntoView({ block: "center" });
  }
}

const TRY_LABEL: Partial<Record<CoachFeatureId, string>> = {
  worktrees: "Choose when",
  queue: "Pick the default",
  pinned: "See suggestions",
  "quick-composer": "See the shortcut",
  orchestration: "Start one",
  habits: "See presets",
  split: "Split this pane",
  palette: "Open it",
};

export function FeatureCoachView({
  counts,
  pins,
  addedPresets,
  busyPreset,
  error,
  onAddPreset,
  onPin,
}: {
  counts: CoachCounts;
  pins: readonly CoachSession[];
  addedPresets: ReadonlySet<string>;
  busyPreset: string | null;
  error?: string;
  onAddPreset: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const [lead, ...rest] = rankCoachCards(counts);
  const leadDone = coachProgress(lead, counts[lead.id]) >= 1;
  return (
    <div data-setting-id="feature-coach" className="flex flex-col gap-8 font-sans">
      <section className="flex flex-wrap items-center gap-x-7 gap-y-4 rounded-2xl bg-accent/[0.08] px-6 py-5">
        <span className="text-accent/90">
          <Ring
            progress={coachProgress(lead, counts[lead.id])}
            count={counts[lead.id]}
            size={104}
          />
        </span>
        <div className="min-w-[16rem] flex-1">
          <p className="text-[12px] font-medium text-content/55">
            {leadDone ? "You use all of these. Nicely done." : "Try this next"}
          </p>
          <h3 className="mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-content [text-wrap:balance]">
            {lead.label}
          </h3>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-content/65 [text-wrap:pretty]">
            {lead.why}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-content/45">
            {counts[lead.id]} {lead.unit}
          </p>
        </div>
        <button
          type="button"
          onClick={() => runTry(lead.id)}
          className={`inline-flex h-8 shrink-0 items-center rounded-lg bg-content px-3 text-[13px] font-medium text-background-base hover:bg-content/85 ${PRESS}`}
        >
          {TRY_LABEL[lead.id]}
        </button>
      </section>

      <section className="grid grid-cols-1 gap-1.5 @min-[560px]/settings:grid-cols-2">
        {rest.map((card: CoachCard) => (
          <div
            key={card.id}
            data-coach-card={card.id}
            className="flex items-start gap-3 rounded-xl bg-content/[0.04] px-3.5 py-3 @min-[560px]/settings:[&:last-child:nth-child(odd)]:col-span-2"
          >
            <span className="text-content/70">
              <Ring
                progress={coachProgress(card, counts[card.id])}
                count={counts[card.id]}
                size={40}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-content">{card.label}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-content/55 [text-wrap:pretty]">
                {card.why}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
                <span className="text-[11px] tabular-nums text-content/40">
                  {card.unit}
                </span>
                <button
                  type="button"
                  onClick={() => runTry(card.id)}
                  className={`-mx-1 rounded-md px-1 text-[12px] font-medium text-accent hover:bg-accent/10 ${PRESS}`}
                >
                  {TRY_LABEL[card.id]}
                </button>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section id="coach-habits">
        <h3 className="text-[14px] font-semibold text-content">Weekly chores for a Mono</h3>
        <p className="mt-0.5 text-[12px] text-content/50">
          Nothing runs until you add it. You can change or remove it from the Mono.
        </p>
        <div className="mt-2.5 grid grid-cols-1 gap-1.5 @min-[560px]/settings:grid-cols-2">
          {HABIT_PRESETS.map((preset) => {
            const added = addedPresets.has(preset.id);
            const working = busyPreset === preset.id;
            return (
              <div
                key={preset.id}
                className="flex flex-col gap-2 rounded-xl bg-content/[0.04] px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-content">{preset.name}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-content/55 [text-wrap:pretty]">
                    {preset.why}
                  </p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className="text-[11px] text-content/45">{preset.when}</span>
                  <button
                    type="button"
                    disabled={added || !!busyPreset}
                    onClick={() => onAddPreset(preset.id)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
                  >
                    {working ? <Loader className="size-3.5 animate-spin" aria-hidden /> : null}
                    {added ? <Check className="size-3.5" aria-hidden /> : null}
                    {added ? "Added" : `Add to ${preset.mono.name}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[12px] text-diff-del-fg">
            {error}
          </p>
        ) : null}
      </section>

      <section id="coach-pins">
        <h3 className="text-[14px] font-semibold text-content">Sessions worth pinning</h3>
        {pins.length ? (
          <>
            <p className="mt-0.5 text-[12px] text-content/50">
              The session with the most changes in each project that has no pin yet.
            </p>
            <ul className="mt-2.5 flex flex-col gap-1">
              {pins.map((session) => (
                <li
                  key={session.id}
                  className="flex min-w-0 items-center gap-3 rounded-xl bg-content/[0.04] px-3.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-content">
                      {session.title || "Untitled session"}
                    </p>
                    <p className="truncate text-[11px] text-content/45" title={prettyCwd(session.cwd)}>
                      {projectName(session.cwd)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onPin(session.id)}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
                  >
                    <Pin className="size-3.5" strokeWidth={1.75} aria-hidden />
                    Pin
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-0.5 text-[12px] text-content/50">
            Nothing to suggest. Every busy project has a pin, or no session has changes yet.
          </p>
        )}
      </section>
    </div>
  );
}

/** Fork: Settings > Tips. Counts are read once each time the page opens. */
export function FeatureCoachPage() {
  const [sessions, setSessions] = useState<CoachSession[]>(
    () => coachHost()?.sessions() ?? [],
  );
  const [habits, setHabits] = useState(0);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [busyPreset, setBusyPreset] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void (async () => {
      let total = 0;
      const names = new Set<string>();
      for (const mono of listMonos()) {
        const list = await loadHabits(mono.id).catch(() => []);
        total += list.length;
        list.forEach((habit) => names.add(habit.name));
      }
      if (!live) return;
      setHabits(total);
      setAdded(
        new Set(
          HABIT_PRESETS.filter((preset) => names.has(preset.name)).map(
            (preset) => preset.id,
          ),
        ),
      );
    })();
    return () => {
      live = false;
    };
  }, []);

  const counts = useMemo(() => coachCounts(sessions, habits), [habits, sessions]);
  const pins = useMemo(() => pinSuggestions(sessions), [sessions]);

  return (
    <FeatureCoachView
      counts={counts}
      pins={pins}
      addedPresets={added}
      busyPreset={busyPreset}
      error={error}
      onAddPreset={(id) => {
        const preset = HABIT_PRESETS.find((entry) => entry.id === id);
        if (!preset) return;
        setBusyPreset(id);
        setError(undefined);
        addHabitPreset(preset)
          .then(() => {
            setAdded((current) => new Set([...current, id]));
            setHabits((current) => current + 1);
          })
          .catch((failure) => setError(String(failure)))
          .finally(() => setBusyPreset(null));
      }}
      onPin={(id) => {
        const host = coachHost();
        if (!host) return;
        void Promise.resolve(host.pin(id))
          .then(() => {
            setSessions((current) =>
              current.map((session) =>
                session.id === id ? { ...session, pinned: true } : session,
              ),
            );
          })
          .catch((failure) => setError(String(failure)));
      }}
    />
  );
}
