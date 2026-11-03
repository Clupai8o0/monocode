import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Bot, ChevronRight, Terminal } from "../../shared/ui/icons";
import type { Block, Session } from "../../features/sessions/model/session";
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
 * It clears when all work finishes; reports stay in the transcript.
 */
export function BackgroundAgentsBar({
  session,
  cwd,
  onOpenFile,
  onOpenDiff,
}: OpenHandlers & {
  session: Pick<Session, "busy" | "blocks" | "queuedMessages">;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useBoardTimings();
  const turn = boardTurn(session);
  const counts = boardCounts(turn.agents);
  const running = counts.running + turn.commands.length;
  useSecondTick(running > 0);
  const visible = boardVisible(turn);
  useEffect(() => {
    if (!visible) {
      setOpen(false);
    }
  }, [visible]);
  if (!visible) {
    return null;
  }
  const now = Date.now();
  const agentRuns = turn.agents.map((block) => timingOf(block, now));
  const commandRuns = turn.commands.map((block) => timingOf(block, now));
  const allRuns = [...agentRuns, ...commandRuns];
  const axis = boardAxis(allRuns, now);
  const laneAxis = boardAxis(agentRuns, now);
  const label = boardLabel(turn);
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
          className="@container/board mt-1 flex max-h-[min(24vh,15rem)] min-w-0 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-lg bg-content/[0.04] px-3 py-2"
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
          {turn.commands.map((block, index) => (
            <CommandRow
              key={block.id}
              block={block}
              timing={commandRuns[index]}
              now={now}
            />
          ))}
        </div>
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
  const [open, setOpen] = useState(false);
  const row = useRevealWhenOpen(open);
  const name = subagentName(block);
  const model = subagentModelName(block);
  const state = toolCallState(block);
  const active = state === "pending";
  const failed = state === "rejected";
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
        <div className="flex min-w-0 flex-col gap-1 py-1 pl-[22px]">
          <pre className="max-h-32 min-w-0 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-content/70">
            {title}
          </pre>
          {/* A running command's output is not sent here until it ends. */}
          <p className="font-sans text-[12px] text-content/45">
            Its output appears in the transcript when it finishes.
          </p>
        </div>
      ) : null}
    </div>
  );
}
