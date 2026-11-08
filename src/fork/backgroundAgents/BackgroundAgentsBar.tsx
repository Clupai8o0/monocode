import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Bot, ChevronRight, Loader, Terminal } from "../../shared/ui/icons";
import type {
  BackgroundJob,
  Block,
  Session,
} from "../../features/sessions/model/session";
import { formatLiveElapsed } from "../../features/sessions/model/liveAgents";
import {
  subagentBrief,
  subagentModelName,
  subagentName,
  subagentReport,
  toolCallState,
} from "../../features/sessions/model/transcriptActivity";
import {
  SubagentMascot,
  SubagentTrail,
} from "../../features/sessions/ui/AgentTranscript";
import { useToolDetail } from "../../features/sessions/ui/useToolDetail";
import {
  agentStatusText,
  axisPercent,
  boardAxis,
  boardCounts,
  boardLabel,
  boardTurn,
  boardVisible,
  isFailedStep,
  quietForMs,
  quietLabel,
  runTiming,
  useBoardTimings,
  type Axis,
  type RunTiming,
} from "./agentBoard";
import { useTaskOutput, type TaskOutput } from "./useTaskOutput";

/** A bar this thin (percent) still reads as a run that has started. */
const MIN_BAR_PERCENT = 0.5;
const NO_STEPS: ReadonlyMap<string, number> = new Map();

type OpenHandlers = {
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
};

/** Re-renders each second while `active`; the clock stops with the work. */
function useSecondTick(active: boolean): void {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * The panel is short, so a row near its edge would open out of sight. Rows open
 * without an animation: while growing they would have no height to reveal yet.
 * `filled` is for a row whose content arrives just after it opens.
 */
function useRevealWhenOpen(open: boolean) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      row.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);
  return row;
}

/** App publishes in an effect, so a new run can render once before it is timed. */
function timingOf(block: Block, now: number): RunTiming {
  return (
    runTiming(block.id) ?? {
      start: now,
      end: toolCallState(block) === "pending" ? null : now,
      lastStepAt: null,
      steps: NO_STEPS,
    }
  );
}

/**
 * Fork: a strip above the composer while the session has subagents or
 * background commands running, like Claude Code's task tray. It opens onto a
 * board with one lane per agent on a shared clock, so overlap and an agent that
 * has gone quiet can be seen at a glance. Details open only on request and
 * scroll within a bounded panel, keeping the composer and conversation usable.
 * Claude background jobs from any turn join the same tray with a stop button.
 * It clears when all work finishes; reports stay in the transcript.
 */
export function BackgroundAgentsBar({
  session,
  cwd,
  onOpenFile,
  onOpenDiff,
  onStopJob,
}: OpenHandlers & {
  session: Pick<
    Session,
    "busy" | "blocks" | "queuedMessages" | "backgroundJobs"
  >;
  onStopJob?: (jobId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const openedFor = useRef<string | null>(null);
  useBoardTimings();
  const turn = boardTurn(session);
  const jobs = session.backgroundJobs ?? [];
  // Prefer Claude's job list (with stop) over the same command's transcript row.
  const jobKeys = new Set(
    jobs.flatMap((job) => [job.title, job.command].filter(Boolean) as string[]),
  );
  const commands = turn.commands.filter((block) => {
    const title = block.tool?.title || block.text;
    const command = block.tool?.command;
    return !(
      (title && jobKeys.has(title)) ||
      (command && jobKeys.has(command))
    );
  });
  const counts = boardCounts(turn.agents);
  const running = counts.running + commands.length + jobs.length;
  useSecondTick(running > 0);
  const visible =
    boardVisible({ agents: turn.agents, commands }) || jobs.length > 0;
  // Open once when work appears so subagents read like live sessions, not a
  // hidden badge. Later collapses stay put until the tray clears.
  const workKey = [
    ...turn.agents.map((block) => block.id),
    ...commands.map((block) => block.id),
    ...jobs.map((job) => job.id),
  ].join(",");
  useEffect(() => {
    if (!visible) {
      openedFor.current = null;
      setOpen(false);
      return;
    }
    if (openedFor.current !== workKey) {
      openedFor.current = workKey;
      setOpen(true);
    }
  }, [visible, workKey]);
  if (!visible) {
    return null;
  }
  const now = Date.now();
  const agentRuns = turn.agents.map((block) => timingOf(block, now));
  const commandRuns = commands.map((block) => timingOf(block, now));
  const jobRuns = jobs.map((job) => ({
    start: job.startedAt,
    end: null as number | null,
    lastStepAt: null as number | null,
    steps: NO_STEPS,
  }));
  const allRuns = [...agentRuns, ...commandRuns, ...jobRuns];
  const axis = boardAxis(allRuns, now);
  const laneAxis = boardAxis(agentRuns, now);
  const labeled = boardLabel({ agents: turn.agents, commands });
  const label =
    labeled ||
    (jobs.length
      ? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} running`
      : "");
  const stopJob = (jobId: string) => {
    if (!onStopJob) return;
    setStopping((ids) => new Set(ids).add(jobId));
    void onStopJob(jobId).catch(() => {
      setStopping((ids) => {
        const next = new Set(ids);
        next.delete(jobId);
        return next;
      });
    });
  };
  return (
    <div
      data-fork-background-agents
      className="mb-1.5 flex min-w-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${open ? "Hide" : "Show"} ${label}${
          counts.failed ? `, ${counts.failed} failed` : ""
        }`}
        onClick={() => setOpen(!open)}
        className={`group flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left font-sans text-[12px] text-content/60 transition-colors duration-200 hover:bg-content/8 hover:text-content ${
          open ? "bg-content/8 text-content" : ""
        }`}
      >
        <Bot className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
        {counts.failed ? (
          <span className="shrink-0 text-red-400">
            {counts.failed} failed
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums text-content/45">
          {formatLiveElapsed(axis.start, axis.end)}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="Background agents and commands"
          tabIndex={0}
          data-fork-agents-board
          className="@container/board mt-1 flex max-h-[min(40vh,22rem)] min-w-0 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-lg bg-content/[0.04] px-3 py-2"
        >
          {turn.agents.map((block, index) => (
            <AgentRow
              key={block.id}
              block={block}
              timing={agentRuns[index]}
              axis={laneAxis}
              now={now}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
          {commands.map((block, index) => (
            <CommandRow
              key={block.id}
              block={block}
              timing={commandRuns[index]}
              now={now}
            />
          ))}
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              now={now}
              stopping={stopping.has(job.id)}
              onStop={onStopJob ? () => stopJob(job.id) : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JobRow({
  job,
  now,
  stopping,
  onStop,
}: {
  job: BackgroundJob;
  now: number;
  stopping: boolean;
  onStop?: () => void;
}) {
  return (
    <div
      className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[12px]"
      title={job.command ? `${job.title}\n${job.command}` : job.title}
    >
      <Terminal
        className="size-3.5 shrink-0 text-content/45"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-content/80">
        {job.title}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content/40">
        {job.command}
      </span>
      <span className="shrink-0 tabular-nums text-content/55">
        {formatLiveElapsed(job.startedAt, now)}
      </span>
      {onStop ? (
        <button
          type="button"
          title={stopping ? "Stopping this job" : "Stop this job"}
          aria-label={`${stopping ? "Stopping" : "Stop"} ${job.title}`}
          disabled={stopping}
          onClick={onStop}
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-content/6 px-2 font-sans text-[12px] text-content/70 transition-colors duration-200 hover:bg-red-500/10 hover:text-red-500 disabled:bg-transparent disabled:text-content/50 dark:hover:text-red-400"
        >
          {stopping ? (
            <>
              <Loader className="size-3 animate-spin" aria-hidden="true" />
              Stopping…
            </>
          ) : (
            "Stop"
          )}
        </button>
      ) : null}
    </div>
  );
}

function AgentRow({
  block,
  timing,
  axis,
  now,
  cwd,
  onOpenFile,
  onOpenDiff,
}: OpenHandlers & {
  block: Block;
  timing: RunTiming;
  axis: Axis;
  now: number;
}) {
  const name = subagentName(block);
  const model = subagentModelName(block);
  const state = toolCallState(block);
  const active = state === "pending";
  const failed = state === "rejected";
  // Running agents with a trail open themselves so the steps stay in view —
  // the point of the tray is watching the work, not hunting for it.
  const [open, setOpen] = useState(
    () => active && (block.agentRun?.steps.length ?? 0) > 0,
  );
  const row = useRevealWhenOpen(open);
  const output = useToolDetail(block, open);
  const hasTrail =
    (block.agentRun?.steps.length ?? 0) > 0 ||
    !!subagentReport(block, output.detail) ||
    output.omitted;
  const quiet = quietForMs(timing, now);

  const body = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <SubagentMascot name={name} state={state} active={active} />
          <span
            className={`min-w-0 truncate font-sans text-[13px] ${
              failed ? "text-red-400" : "text-content/80"
            }`}
          >
            {name}
          </span>
          {model ? (
            <span className="min-w-0 shrink-[2] truncate font-sans text-[12px] text-content/40">
              {model}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 pl-[22px] font-sans text-[12px]">
          <span
            className={`min-w-0 truncate ${
              failed
                ? "text-red-400"
                : active
                  ? "text-content/55"
                  : "text-content/40"
            }`}
          >
            {agentStatusText(block)}
          </span>
          {quiet !== null ? (
            <span className="shrink-0 text-amber-700 dark:text-amber-400">
              {quietLabel(quiet)}
            </span>
          ) : null}
        </span>
      </span>
      <AgentLane block={block} timing={timing} axis={axis} now={now} />
      <span className="text-right font-sans text-[12px] tabular-nums text-content/55">
        {formatLiveElapsed(timing.start, timing.end ?? now)}
      </span>
      <span className="flex size-3.5 items-center justify-center">
        {hasTrail ? (
          <ChevronRight
            className={`size-3.5 text-content/35 transition-transform duration-200 group-hover:text-content/60 ${
              open ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        ) : null}
      </span>
    </>
  );

  // Wide: text, lane, time, chevron. Narrow: the lane drops under the rest. The
  // time column is a fixed width so every lane spans the same stretch of clock.
  const grid =
    "-mx-1.5 grid min-w-0 grid-cols-[minmax(0,1fr)_3.25rem_0.875rem] items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 text-left @[520px]/board:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.25rem_0.875rem]";
  if (!hasTrail) {
    return (
      <div
        aria-label={`Subagent: ${name}`}
        title={subagentBrief(block)}
        className={grid}
      >
        {body}
      </div>
    );
  }
  return (
    <div ref={row} className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide ${name}'s work` : `Show ${name}'s work`}
        title={subagentBrief(block)}
        onClick={() => {
          setOpen(!open);
        }}
        className={`group ${grid} transition-colors duration-200 hover:bg-content/8 ${
          open ? "bg-content/8" : ""
        }`}
      >
        {body}
      </button>
      {open ? (
        <div className="min-w-0 pl-[22px]">
          <SubagentTrail
            block={block}
            cwd={cwd}
            active={active}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One agent's run on the board's clock: a bar, and a tick per tool step. */
function AgentLane({
  block,
  timing,
  axis,
  now,
}: {
  block: Block;
  timing: RunTiming;
  axis: Axis;
  now: number;
}) {
  const state = toolCallState(block);
  const left = Math.min(
    axisPercent(axis, timing.start),
    100 - MIN_BAR_PERCENT,
  );
  const width = Math.max(
    axisPercent(axis, timing.end ?? now) - left,
    MIN_BAR_PERCENT,
  );
  const barFill =
    state === "rejected"
      ? "fill-red-400/35"
      : state === "pending"
        ? "fill-accent/35"
        : "fill-content/20";
  const tickFill = state === "pending" ? "fill-accent" : "fill-content/50";
  return (
    <span className="order-last col-span-full block min-w-0 @[520px]/board:order-none @[520px]/board:col-span-1">
      <svg
        aria-hidden="true"
        width="100%"
        height="12"
        className="block overflow-visible"
      >
        <rect
          x="0"
          y="3"
          width="100%"
          height="6"
          rx="3"
          className="fill-content/[0.06]"
        />
        <rect
          x={`${left}%`}
          y="3"
          width={`${width}%`}
          height="6"
          rx="3"
          className={barFill}
        />
        {block.agentRun?.steps.map((step) => {
          const seen = timing.steps.get(step.id);
          if (step.kind !== "tool" || seen === undefined) {
            return null;
          }
          return (
            <rect
              key={step.id}
              x={`${axisPercent(axis, seen)}%`}
              y="2"
              width="1.5"
              height="8"
              className={isFailedStep(step) ? "fill-red-400" : tickFill}
            />
          );
        })}
      </svg>
    </span>
  );
}

function CommandRow({
  block,
  timing,
  now,
}: {
  block: Block;
  timing: RunTiming;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const output = useTaskOutput(block.tool?.outputPath, open);
  const row = useRevealWhenOpen(open);
  const title = block.tool?.title || block.text || "Command";
  return (
    <div ref={row} className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} command: ${title}`}
        title={title}
        onClick={() => {
          setOpen(!open);
        }}
        className={`group -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-200 hover:bg-content/8 ${
          open ? "bg-content/8" : ""
        }`}
      >
        <Terminal
          className="size-3.5 shrink-0 text-content/45"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span
          className={`min-w-0 flex-1 truncate text-[12px] ${
            open ? "font-sans text-content/55" : "font-mono text-content/70"
          }`}
        >
          {open ? "Command" : title}
        </span>
        <span className="shrink-0 font-sans text-[12px] tabular-nums text-content/55">
          {formatLiveElapsed(timing.start, timing.end ?? now)}
        </span>
        <ChevronRight
          className={`size-3.5 shrink-0 text-content/35 transition-transform duration-200 group-hover:text-content/60 ${
            open ? "rotate-90" : ""
          }`}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <CommandConsole
          script={block.tool?.command || title}
          output={output}
          hasFile={!!block.tool?.outputPath && !output.unavailable}
        />
      ) : null}
    </div>
  );
}

/**
 * The script, then its output, in one scroller sized to fit the capped panel
 * under its row, so the newest line is never cut off. Follows new output unless
 * the reader has scrolled up to look at older lines.
 */
function CommandConsole({
  script,
  output,
  hasFile,
}: {
  script: string;
  output: TaskOutput;
  hasFile: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const height = useRef(0);
  useLayoutEffect(() => {
    const view = box.current;
    if (!view || !following.current) {
      return;
    }
    view.scrollTop = view.scrollHeight;
    // Still growing, so its end may be under the panel's fold. Once it is full
    // it scrolls itself, and leaves the panel to whoever is reading other rows.
    if (view.clientHeight !== height.current) {
      height.current = view.clientHeight;
      view.scrollIntoView?.({ block: "nearest" });
    }
  }, [output.text, output.truncated]);
  const note = commandNote(hasFile, output);
  return (
    <div className="min-w-0 py-1 pl-[22px]">
      <div
        ref={box}
        role="group"
        tabIndex={0}
        aria-label="Command and its output"
        data-fork-command-console
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          following.current = scrollHeight - scrollTop - clientHeight < 8;
        }}
        className="max-h-[calc(min(24vh,15rem)-3.25rem)] min-w-0 space-y-1.5 overflow-y-auto rounded-md bg-content/[0.05] px-2 py-1.5 text-[12px] leading-5"
      >
        <pre className="min-w-0 whitespace-pre-wrap break-all font-mono text-content/80">
          {script}
        </pre>
        {note ? <p className="font-sans text-content/45">{note}</p> : null}
        {hasFile && output.text ? (
          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-content/60">
            {output.text}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function commandNote(hasFile: boolean, output: TaskOutput): string | null {
  if (!hasFile) {
    // Only Claude's commands on this machine leave a file to read.
    return "Its output appears in the transcript when it finishes.";
  }
  if (output.text === "" && !output.truncated) {
    return "No output yet.";
  }
  return output.truncated ? "Earlier output left out." : null;
}
