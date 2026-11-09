/**
 * Fork feature: Project home. One project's roadmap, what waits on the user
 * and its chats by phase; or, for All projects, the same across every
 * project. Design: docs/mockups/project-home.html (v3).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import { sameProjectPath } from "../../features/projects/model/recents";
import { liveAgentsFromSessions } from "../../features/sessions/model/liveAgents";
import type { Session } from "../../features/sessions/model/session";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import {
  CurrentProjectIcon,
  useProjectLabel,
} from "../../features/projects/ui/CurrentProjectIcon";
import { OverlayNav } from "../../app/shell/TitleBar";
import { WindowControls } from "../../app/shell/WindowControls";
import { IS_MAC } from "../../platform/tauri/platform";
import { Popover } from "../../shared/ui/Popover";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  File,
  Home,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Sparkles,
} from "../../shared/ui/icons";
import { handoffAge } from "../handoff/handoffModel";
import { continueFromHandoff } from "../handoff/handoffStore";
import { useHandoff } from "../handoff/HandoffCard";
import {
  chatPhase,
  DAY_MS,
  homeChats,
  needsItems,
  phaseIsActive,
  shortAge,
  type ChatState,
  type HomeChat,
  type NeedsItem,
} from "./homeModel";
import {
  launchHomeChat,
  linkSessionToPhase,
  savePhaseStatus,
  usePhaseLinks,
  usePlans,
  type HomePage,
  type PlanState,
} from "./homeStore";
import {
  currentPhase,
  DEFAULT_PLAN_FILE,
  doneCount,
  fillPlanPrompt,
  PHASE_STATUS_LABEL,
  PHASE_STATUSES,
  shortDate,
  startPhasePrompt,
  type PhaseStatus,
  type PlanPhase,
} from "./planModel";

type Props = {
  page: HomePage;
  /** The inset layout shows the tab strip above, so no header here. */
  tabbed: boolean;
  besideRail: boolean;
  compactRail: boolean;
  /** Every project the sidebar lists, for All projects. */
  projects: readonly string[];
  /** Sessions loaded this run, across projects. */
  sessions: Session[];
  /** Saved chats across the projects visited this run. */
  summaries: readonly SessionSummary[];
  unseenIds: ReadonlySet<string>;
  onClose: () => void;
  onToggleSidebar?: () => void;
  onOpenChat: (sessionId: string) => void;
  onOpenProjectHome: (cwd: string) => void;
  onOpenAllProjects: () => void;
  onOpenFile: (path: string) => void;
  onNewChat: (cwd: string) => void;
};

const BTN =
  "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[12px] font-medium outline-none transition-[background-color,transform] duration-150 focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-40";
const GHOST = `${BTN} border border-content/12 text-content/80 hover:bg-content/8 hover:text-content`;
const SOLID = `${BTN} bg-content text-background-base hover:bg-content/85`;
const SMALL = "h-[26px] px-2.5";
const CARD = "rounded-xl bg-content/4";
const ROW =
  "flex w-full min-w-0 items-center gap-3 rounded-lg p-2.5 text-left outline-none transition-colors duration-150 hover:bg-content/5 focus-visible:ring-1 focus-visible:ring-accent";
const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-content/80 hover:bg-content/8 hover:text-content";

const STATUS_TEXT: Record<PhaseStatus, string> = {
  todo: "text-content/55",
  progress: "text-accent",
  built: "text-violet-400",
  blocked: "text-red-400",
  done: "text-emerald-400",
};

const STATE_LABEL: Record<ChatState, string> = {
  waiting: "Waiting",
  working: "Working",
  unseen: "New reply",
  idle: "",
};

const STATE_TEXT: Record<ChatState, string> = {
  waiting: "text-amber-400",
  working: "text-accent",
  unseen: "text-emerald-400",
  idle: "text-content/40",
};

export function ProjectHomePage(props: Props) {
  const { page, tabbed, besideRail, compactRail, onClose, onToggleSidebar } = props;
  const label = useProjectLabel(page.kind === "home" ? page.cwd : "");
  const title = page.kind === "home" ? label : "All projects";
  const scroller = useRef<HTMLDivElement>(null);
  const key = page.kind === "home" ? page.cwd : "*all";
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [key]);
  return (
    <div
      role="region"
      aria-label={page.kind === "home" ? `${title} home` : title}
      data-fork-project-home={page.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      {!tabbed ? (
        <div
          data-app-view-header
          className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
          data-tauri-drag-region="deep"
        >
          {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
          {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
          {besideRail ? null : (
            <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
            <Home className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
            <span className="min-w-0 truncate text-content">{title}</span>
          </div>
          {IS_MAC ? null : <WindowControls />}
        </div>
      ) : null}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        {page.kind === "home" ? (
          <ProjectHome key={page.cwd} cwd={page.cwd} {...props} />
        ) : (
          <AllProjects {...props} />
        )}
      </div>
    </div>
  );
}

// --- Shared pieces ------------------------------------------------------------

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-col gap-9 px-8 pb-24 pt-8 max-[620px]:px-4">
      {children}
    </div>
  );
}

function Section({
  title,
  count,
  amber = false,
  meta,
  children,
}: {
  title: string;
  count?: number;
  amber?: boolean;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {count !== undefined ? (
          <span
            className={`text-[13px] tabular-nums ${
              amber && count > 0 ? "text-amber-400" : "text-content/40"
            }`}
          >
            {count}
          </span>
        ) : null}
        <span className="flex-1" />
        {meta ? (
          <span className="whitespace-nowrap text-[12px] text-content/40">{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  of,
  amber = false,
}: {
  label: string;
  value: number;
  of?: number;
  amber?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-[10px] bg-content/4 px-3.5 py-3">
      <div className="text-[11px] text-content/50">{label}</div>
      <div
        className={`mt-0.5 text-[18px] font-semibold tabular-nums tracking-[-0.01em] ${
          amber && value > 0 ? "text-amber-400" : ""
        }`}
      >
        {value}
        {of !== undefined ? (
          <small className="ml-1 text-[12px] font-normal text-content/45">of {of}</small>
        ) : null}
      </div>
    </div>
  );
}

function Stats({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2.5">
      {children}
    </div>
  );
}

function Header({
  icon,
  title,
  line,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  line: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 items-center gap-3.5">
      {icon}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[22px] font-semibold leading-7 tracking-[-0.015em]">
          {title}
        </h1>
        <div className="mt-0.5 truncate text-[13px] text-content/60">{line}</div>
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </header>
  );
}

/** A phase's status as a circle: empty, dot, half, dash or tick. */
function Glyph({ status, small = false }: { status: PhaseStatus; small?: boolean }) {
  const size = small ? "size-3.5 border-[1.25px]" : "size-5 border-[1.5px]";
  const inner = small ? "scale-75" : "";
  if (status === "done") {
    return (
      <span
        aria-hidden
        className={`grid shrink-0 place-items-center rounded-full border-transparent bg-emerald-400/20 text-emerald-300 ${size}`}
      >
        <Check className={small ? "size-2.5" : "size-3"} strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "built") {
    return (
      <span
        aria-hidden
        className={`shrink-0 rounded-full border-violet-400 ${size}`}
        style={{ background: "linear-gradient(90deg, rgb(167 139 250) 50%, transparent 50%)" }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full ${size} ${
        status === "progress"
          ? "border-accent"
          : status === "blocked"
            ? "border-red-400"
            : "border-content/25"
      }`}
    >
      {status === "progress" ? (
        <span className={`size-2 rounded-full bg-accent ${inner}`} />
      ) : status === "blocked" ? (
        <span className={`h-0.5 w-2 rounded-[1px] bg-red-400 ${inner}`} />
      ) : null}
    </span>
  );
}

function NeedsPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-400/12 px-2 py-0.5 text-[11px] font-semibold text-amber-400">
      <CircleAlert className="size-3" strokeWidth={2} aria-hidden />
      Needs you
    </span>
  );
}

function ChatStateLabel({ state }: { state: ChatState }) {
  if (state === "idle") {
    return null;
  }
  return (
    <span className={`shrink-0 whitespace-nowrap text-[11px] ${STATE_TEXT[state]}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

function StatusButton({
  phase,
  onPick,
}: {
  phase: PlanPhase;
  onPick: (status: PhaseStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={phase.statusNote ? `Set by ${phase.statusNote}. Click to change.` : "Click to set the status"}
        onClick={() => setOpen((was) => !was)}
        className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-content/6 px-2 text-[12px] outline-none transition-colors duration-150 hover:bg-content/12 focus-visible:ring-1 focus-visible:ring-accent ${STATUS_TEXT[phase.status]}`}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {PHASE_STATUS_LABEL[phase.status]}
        <ChevronDown className="size-3" strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="bottom"
          align="end"
          gap={4}
          width={170}
          autoFocus
          onDismiss={() => setOpen(false)}
          role="menu"
          aria-label={`Status of phase ${phase.id}`}
          className="overflow-hidden p-1 font-sans text-content"
        >
          {PHASE_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={status === phase.status}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false);
                if (status !== phase.status) {
                  onPick(status);
                }
              }}
              className={MENU_ITEM}
            >
              <Glyph status={status} small />
              <span className="min-w-0 flex-1 truncate">{PHASE_STATUS_LABEL[status]}</span>
              {status === phase.status ? (
                <Check className="size-3.5 text-content/60" strokeWidth={2} aria-hidden />
              ) : null}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

/** Puts a chat on a phase, or takes it off. */
function LinkMenu({
  anchor,
  chatId,
  phases,
  current,
  onClose,
}: {
  anchor: HTMLElement;
  chatId: string;
  phases: readonly PlanPhase[];
  current: string | null;
  onClose: () => void;
}) {
  const pick = (phaseId: string) => {
    linkSessionToPhase(chatId, phaseId);
    onClose();
  };
  return (
    <Popover
      anchor={anchor}
      side="bottom"
      align="start"
      gap={4}
      width={260}
      maxHeight={320}
      autoFocus
      onDismiss={onClose}
      role="menu"
      aria-label="Put this chat on a phase"
      className="overflow-y-auto p-1 font-sans text-content"
    >
      <div className="px-2 pb-1 pt-1.5 text-[11px] text-content/45">Put on a phase</div>
      {phases.map((phase) => (
        <button
          key={phase.id}
          type="button"
          role="menuitemradio"
          aria-checked={phase.id === current}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(phase.id)}
          className={MENU_ITEM}
        >
          <Glyph status={phase.status} small />
          <span className="w-7 shrink-0 font-mono text-[11px] text-content/45">{phase.id}</span>
          <span className="min-w-0 flex-1 truncate">{phase.name}</span>
          {phase.id === current ? (
            <Check className="size-3.5 text-content/60" strokeWidth={2} aria-hidden />
          ) : null}
        </button>
      ))}
      {current !== null ? (
        <button
          type="button"
          role="menuitem"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick("")}
          className={MENU_ITEM}
        >
          <span className="min-w-0 flex-1 truncate text-content/60">Not on a phase</span>
        </button>
      ) : null}
    </Popover>
  );
}

function ChatRow({
  chat,
  phases,
  onOpen,
}: {
  chat: HomeChat;
  phases: readonly PlanPhase[];
  onOpen: (id: string) => void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <div className="group/chat -mx-2 flex min-w-0 items-center rounded-md hover:bg-content/6">
      <button
        type="button"
        title={chat.activity ?? chat.last ?? chat.title}
        onClick={() => onOpen(chat.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-content/85 outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <HarnessIcon harness={chat.harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        <ChatStateLabel state={chat.state} />
      </button>
      <button
        type="button"
        aria-label={`Move ${chat.title} to another phase`}
        title="Move to another phase"
        onClick={(event) => setMenu(event.currentTarget)}
        className="mr-1 grid size-6 shrink-0 place-items-center rounded text-content/40 opacity-0 outline-none hover:bg-content/10 hover:text-content focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent group-hover/chat:opacity-100"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
      </button>
      {menu ? (
        <LinkMenu
          anchor={menu}
          chatId={chat.id}
          phases={phases}
          current={chat.phaseId}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function Checks({ phase }: { phase: PlanPhase }) {
  if (!phase.checks.length) {
    return <p className="text-[12.5px] text-content/45">No done-when checks in the plan.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {phase.checks.map((check, index) => (
        <li
          key={`${index}:${check.text}`}
          className="flex items-start gap-2 text-[12.5px] leading-4 text-content/82"
        >
          <span
            aria-hidden
            className={`grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-200 ${
              check.met
                ? "border-transparent bg-emerald-400/20 text-emerald-300"
                : "border-content/25"
            }`}
          >
            {check.met ? <Check className="size-2.5" strokeWidth={2.5} /> : null}
          </span>
          <span className={check.met ? "text-content/45" : ""}>
            <span className="sr-only">{check.met ? "Met: " : "Not met: "}</span>
            {check.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NeedsList({
  items,
  showProject,
  empty,
  now,
  onOpen,
}: {
  items: readonly NeedsItem[];
  showProject: boolean;
  empty: string;
  now: number;
  onOpen: (sessionId: string) => void;
}) {
  return (
    <div className={CARD}>
      {items.length ? (
        <div className="flex flex-col p-1">
          {items.map((item) => (
            <NeedsRow
              key={item.key}
              item={item}
              showProject={showProject}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : (
        <div className="p-[18px] text-[13px] text-content/45">{empty}</div>
      )}
    </div>
  );
}

function NeedsRow({
  item,
  showProject,
  now,
  onOpen,
}: {
  item: NeedsItem;
  showProject: boolean;
  now: number;
  onOpen: (sessionId: string) => void;
}) {
  const project = useProjectLabel(item.cwd);
  const where = [
    showProject ? project : null,
    item.phaseId ? `Phase ${item.phaseId}` : null,
    item.chatTitle,
  ].filter(Boolean);
  const old = now - item.since >= DAY_MS;
  return (
    <button type="button" onClick={() => onOpen(item.sessionId)} className={`${ROW} group/needs`}>
      <span
        className={`grid size-7 shrink-0 place-items-center overflow-hidden rounded-[7px] ${
          showProject ? "bg-content/6" : "bg-amber-400/12 text-amber-400"
        }`}
      >
        {showProject ? (
          <CurrentProjectIcon cwd={item.cwd} className="size-7" mascotClassName="size-4" />
        ) : (
          <CircleAlert className="size-3.5" strokeWidth={2} aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-[18px] text-content/92">
          {item.text}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px] text-content/45">
          <span className="min-w-0 truncate">{where.join(" · ")}</span>
          {item.chatIdle ? (
            <span
              className="shrink-0 whitespace-nowrap"
              title="This chat is not running. Replying wakes it."
            >
              · chat idle
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        <span className="whitespace-nowrap text-[11px] text-content/55 max-[620px]:hidden">
          {item.kind}
        </span>
        <span
          className={`min-w-[26px] whitespace-nowrap text-right text-[12px] tabular-nums ${
            old ? "font-medium text-amber-400" : "text-content/45"
          }`}
          title={old ? "Waiting over a day" : undefined}
        >
          {shortAge(item.since, now)}
        </span>
        <span className={`${GHOST} ${SMALL} pointer-events-none`}>Open</span>
      </span>
    </button>
  );
}

function HandoffSection({ cwd }: { cwd: string }) {
  const handoff = useHandoff(cwd);
  if (!handoff) {
    return null;
  }
  return (
    <section className={`${CARD} px-[18px] py-4`}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-content/50">
        <CornerDownRight className="size-3 text-accent" strokeWidth={2} aria-hidden />
        <span>Latest handoff</span>
        <span className="flex-1" />
        <span title={handoff.path}>{handoffAge(handoff.mtimeMs, Date.now())}</span>
      </div>
      {handoff.heading ? (
        <p className="text-[14px] font-medium leading-[1.55] text-content/88 [text-wrap:pretty]">
          {handoff.heading}
        </p>
      ) : null}
      {handoff.line ? (
        <p className="mt-0.5 line-clamp-3 text-[13px] leading-[1.55] text-content/60 [text-wrap:pretty]">
          {handoff.line}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => continueFromHandoff(cwd)}
        className={`${GHOST} ${SMALL} mt-3`}
      >
        Continue from it
      </button>
    </section>
  );
}

/** A short-lived note at the bottom of the page, with an optional undo. */
type Notice = { text: string; undo?: () => void };

function useNotice(): [Notice | null, (notice: Notice | null) => void] {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

function NoticeBar({ notice, onDone }: { notice: Notice | null; onDone: () => void }) {
  if (!notice) {
    return null;
  }
  return (
    <div className="pointer-events-none sticky bottom-4 z-10 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-lg border border-content/10 bg-background-base px-3 py-2 text-[12.5px] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.55)]"
      >
        <span className="text-content/85">{notice.text}</span>
        {notice.undo ? (
          <button
            type="button"
            onClick={() => {
              notice.undo?.();
              onDone();
            }}
            className="font-medium text-accent hover:underline"
          >
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}

// --- One project ----------------------------------------------------------------

function ProjectHome({
  cwd,
  sessions,
  summaries,
  unseenIds,
  onOpenChat,
  onOpenAllProjects,
  onOpenFile,
  onNewChat,
}: Props & { cwd: string }) {
  const label = useProjectLabel(cwd);
  const plans = usePlans(useMemo(() => [cwd], [cwd]));
  const state = plans.get(cwd) as PlanState;
  const links = usePhaseLinks();
  const phases = useMemo(() => state.plan?.phases ?? [], [state.plan]);
  const agents = useMemo(
    () => liveAgentsFromSessions(sessions, unseenIds),
    [sessions, unseenIds],
  );
  const chats = useMemo(
    () => homeChats(cwd, summaries, sessions, agents, phases, links),
    [cwd, summaries, sessions, agents, phases, links],
  );
  const updated = useMemo(
    () => new Map(summaries.map((summary) => [summary.id, summary.updatedAt])),
    [summaries],
  );
  const now = useNow();
  const needs = useMemo(
    () =>
      needsItems(cwd, sessions, agents, updated, (session) =>
        chatPhase(session.id, session.title, phases, links),
      ),
    [cwd, sessions, agents, updated, phases, links],
  );
  const [notice, setNotice] = useNotice();
  const file = state.file ?? DEFAULT_PLAN_FILE;
  const working = chats.filter((chat) => chat.state === "working").length;
  const icon = (
    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-content/6">
      <CurrentProjectIcon cwd={cwd} className="size-10" mascotClassName="size-6" />
    </span>
  );
  const allLink = (
    <button
      type="button"
      onClick={onOpenAllProjects}
      className="-mb-6 inline-flex items-center gap-1 self-start text-[12px] text-content/45 outline-none hover:text-content focus-visible:text-content"
    >
      All projects
      <ChevronRight className="size-3" strokeWidth={2} aria-hidden />
    </button>
  );
  const startChat = (prompt: string, title: string) => {
    if (!launchHomeChat({ cwd, prompt, title, reveal: true })) {
      setNotice({ text: "Could not start a chat yet. Try again in a moment." });
    }
  };
  const fillPlan = () =>
    startChat(fillPlanPrompt(state.file), state.plan ? "Update the roadmap" : "Draft a roadmap");
  const setStatus = (phase: PlanPhase, status: PhaseStatus) => {
    const before = { status: phase.status, note: phase.statusNote };
    void savePhaseStatus(cwd, phase.id, status, shortDate()).then((ok) => {
      if (!ok) {
        setNotice({ text: `Could not save to ${file}.` });
        return;
      }
      setNotice({
        text: `Phase ${phase.id} set to ${PHASE_STATUS_LABEL[status]}.`,
        undo: () => {
          void savePhaseStatus(cwd, phase.id, before.status, before.note);
        },
      });
    });
  };
  const startPhase = (phase: PlanPhase) => {
    const id = launchHomeChat({
      cwd,
      prompt: startPhasePrompt(file, phase),
      title: `Phase ${phase.id} ${phase.name}`,
      reveal: true,
    });
    if (!id) {
      setNotice({ text: "Could not start a chat yet. Try again in a moment." });
      return;
    }
    linkSessionToPhase(id, phase.id);
    if (phase.status === "todo") {
      void savePhaseStatus(cwd, phase.id, "progress", shortDate());
    }
  };

  if (!state.loaded) {
    return (
      <Page>
        {allLink}
        <Header icon={icon} title={label} line="Reading the roadmap…" />
        <div className="grid place-items-center py-12 text-content/35">
          <LoaderCircle className="size-4 animate-spin" aria-label="Loading" />
        </div>
      </Page>
    );
  }

  if (!state.plan) {
    return (
      <Page>
        {allLink}
        <Header
          icon={icon}
          title={label}
          line={`No plan yet · ${chats.length} ${chats.length === 1 ? "chat" : "chats"}`}
        >
          <button type="button" onClick={() => onNewChat(cwd)} className={GHOST}>
            <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
            New chat
          </button>
        </Header>
        <HandoffSection cwd={cwd} />
        <Section title="Needs you" count={needs.length} amber meta={needs.length > 1 ? "oldest first" : undefined}>
          <NeedsList items={needs} showProject={false} empty="Nothing needs you here." now={now} onOpen={onOpenChat} />
        </Section>
        <section
          className={`${CARD} flex items-center gap-4 px-[18px] py-4 max-[620px]:flex-col max-[620px]:items-start`}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">No roadmap yet</div>
            <div className="mt-1 text-[13px] leading-normal text-content/55">
              A chat reads the README, the handoff and the git log, then writes a phase
              table to {DEFAULT_PLAN_FILE} for you to check.
            </div>
          </div>
          <button type="button" onClick={fillPlan} className={SOLID}>
            <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
            Draft a plan
          </button>
        </section>
        {chats.length ? (
          <Section title="Chats" count={chats.length}>
            <div className={`${CARD} flex flex-col p-1`}>
              {chats.slice(0, 12).map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => onOpenChat(chat.id)}
                  className={ROW}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-content/6">
                    <HarnessIcon harness={chat.harness} className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-content/92">
                      {chat.title}
                    </span>
                    {chat.activity || chat.last ? (
                      <span className="mt-0.5 block truncate text-[12px] text-content/45">
                        {chat.activity ?? chat.last}
                      </span>
                    ) : null}
                  </span>
                  <ChatStateLabel state={chat.state} />
                </button>
              ))}
            </div>
          </Section>
        ) : null}
        <NoticeBar notice={notice} onDone={() => setNotice(null)} />
      </Page>
    );
  }

  const now0 = currentPhase(phases);
  const active = phases.filter((phase) => phaseIsActive(phase, chats, needs));
  const next = phases.filter((phase) => phase.status !== "done" && !active.includes(phase));
  const done = phases.filter((phase) => phase.status === "done" && !active.includes(phase));
  const loose = chats.filter((chat) => chat.phaseId === null).slice(0, 16);
  const doneTotal = doneCount(phases);

  return (
    <Page>
      {allLink}
      <Header
        icon={icon}
        title={label}
        line={
          now0 ? (
            <>
              Now:{" "}
              <b className="font-medium text-content/90">
                Phase {now0.id} · {now0.name}
              </b>
            </>
          ) : (
            <b className="font-medium text-content/90">All phases done</b>
          )
        }
      >
        <button
          type="button"
          aria-label={`Open ${file}`}
          title={`Open ${file}`}
          onClick={() => onOpenFile(`${cwd.replace(/\/+$/, "")}/${file}`)}
          className={GHOST}
        >
          <File className="size-3.5" strokeWidth={1.75} aria-hidden />
          <span className="max-[620px]:hidden">{file.split("/").pop()}</span>
        </button>
        <button type="button" aria-label="New chat" onClick={() => onNewChat(cwd)} className={SOLID}>
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
          <span className="max-[620px]:hidden">New chat</span>
        </button>
      </Header>
      <Stats>
        <Stat label="Phases done" value={doneTotal} of={phases.length} />
        <Stat label="Needs you" value={needs.length} amber />
        <Stat label="Chats working" value={working} />
      </Stats>
      <HandoffSection cwd={cwd} />
      <Section title="Needs you" count={needs.length} amber meta={needs.length > 1 ? "oldest first" : undefined}>
        <NeedsList items={needs} showProject={false} empty={`Nothing needs you on ${label}.`} now={now} onOpen={onOpenChat} />
      </Section>
      <Section title="Roadmap" meta={`from ${file}`}>
        {!state.plan.hasStatusColumn ? (
          <div className={`${CARD} mb-5 flex items-center gap-3 px-4 py-3 max-[620px]:flex-col max-[620px]:items-start`}>
            <div className="min-w-0 flex-1 text-[13px] text-content/60">
              The plan has no Status column, so every phase shows as not started.
            </div>
            <button type="button" onClick={fillPlan} className={`${GHOST} ${SMALL}`}>
              <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
              Ask a chat to fill it
            </button>
          </div>
        ) : null}
        {active.length ? (
          <>
            <SubHeading label="Active" count={active.length} />
            <div className="flex flex-col gap-2.5">
              {active.map((phase) => (
                <PhaseCard
                  key={phase.id}
                  phase={phase}
                  phases={phases}
                  chats={chats.filter((chat) => chat.phaseId === phase.id)}
                  asks={needs.filter((item) => item.phaseId === phase.id).length}
                  onStatus={(status) => setStatus(phase, status)}
                  onStart={() => startPhase(phase)}
                  onOpenChat={onOpenChat}
                />
              ))}
            </div>
          </>
        ) : null}
        {next.length ? (
          <>
            <SubHeading label="Up next" count={next.length} />
            <div className={`${CARD} p-1`}>
              {next.map((phase) => (
                <MiniRow
                  key={phase.id}
                  phase={phase}
                  phases={phases}
                  chats={chats.filter((chat) => chat.phaseId === phase.id)}
                  action={
                    <button type="button" onClick={() => startPhase(phase)} className={`${GHOST} ${SMALL}`}>
                      Start
                    </button>
                  }
                  onOpenChat={onOpenChat}
                />
              ))}
            </div>
          </>
        ) : null}
        {done.length ? (
          <DoneGroup
            phases={phases}
            done={done}
            chats={chats}
            onStatus={setStatus}
            onOpenChat={onOpenChat}
          />
        ) : null}
        <div className="mt-4 flex">
          <button type="button" onClick={fillPlan} className={`${GHOST} ${SMALL}`}>
            <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
            Ask a chat to update the roadmap
          </button>
        </div>
      </Section>
      {loose.length ? (
        <Section title="Chats not on a phase" count={loose.length} meta="click one to put it on a phase">
          <div className="flex flex-wrap gap-1.5">
            {loose.map((chat) => (
              <LooseChip key={chat.id} chat={chat} phases={phases} />
            ))}
          </div>
        </Section>
      ) : null}
      <NoticeBar notice={notice} onDone={() => setNotice(null)} />
    </Page>
  );
}

function SubHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 mt-5 flex items-center gap-1.5 text-[12px] font-medium text-content/50 first:mt-0">
      {label}
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

function PhaseCard({
  phase,
  phases,
  chats,
  asks,
  onStatus,
  onStart,
  onOpenChat,
}: {
  phase: PlanPhase;
  phases: readonly PlanPhase[];
  chats: readonly HomeChat[];
  asks: number;
  onStatus: (status: PhaseStatus) => void;
  onStart: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const working = chats.filter((chat) => chat.state === "working").length;
  const newest =
    chats.find((chat) => chat.state === "working" && chat.activity) ??
    chats.find((chat) => chat.state === "waiting") ??
    chats.find((chat) => chat.last);
  const met = phase.checks.filter((check) => check.met).length;
  const looksDone =
    phase.status !== "done" && phase.checks.length > 0 && met === phase.checks.length;
  const bodyId = `fork-phase-${phase.id}`;
  return (
    <div className={CARD} data-phase={phase.id}>
      <div className="flex min-w-0 items-center gap-3 px-4 py-3.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Glyph status={phase.status} />
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-[11px] text-content/45">PHASE {phase.id}</span>
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">
              {phase.name}
            </span>
          </span>
        </button>
        {asks ? <NeedsPill /> : null}
        {working ? (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-accent max-[620px]:hidden">
            <LoaderCircle className="size-3 animate-spin" aria-hidden />
            {working} working
          </span>
        ) : null}
        <StatusButton phase={phase} onPick={onStatus} />
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className="grid size-6 shrink-0 place-items-center rounded text-content/45 outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ChevronRight
            className={`size-3.5 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      </div>
      <div
        id={bodyId}
        inert={!open || undefined}
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-4 pb-4 pl-12 pr-4 max-[620px]:pl-4">
            {phase.what ? (
              <p className="max-w-[62ch] text-[13px] leading-normal text-content/60">{phase.what}</p>
            ) : null}
            {newest ? (
              <div className="flex items-start gap-2.5 rounded-lg bg-content/4 px-3 py-2.5">
                <HarnessIcon harness={newest.harness} className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0">
                  <div className="line-clamp-2 text-[13px] leading-normal text-content/85">
                    {newest.activity ?? newest.last}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-content/45">
                    {newest.title}
                    {newest.state !== "idle" ? ` · ${STATE_LABEL[newest.state].toLowerCase()}` : ""}
                  </div>
                </div>
              </div>
            ) : null}
            {looksDone ? (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-400/8 px-3 py-2.5">
                <div className="min-w-0 flex-1 text-[13px] text-emerald-300">
                  Looks done
                  <small className="mt-px block text-[11px] text-content/45">
                    Every done-when is met. Nothing changes until you mark it.
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => onStatus("done")}
                  className={`${BTN} ${SMALL} border border-emerald-400/35 text-emerald-300 hover:bg-emerald-400/10`}
                >
                  Mark done
                </button>
              </div>
            ) : null}
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 max-[620px]:grid-cols-1">
              <div>
                <div className="mb-2 text-[11px] font-medium text-content/45">
                  Done when · {met} of {phase.checks.length}
                </div>
                <Checks phase={phase} />
              </div>
              <div>
                <div className="mb-2 text-[11px] font-medium text-content/45">
                  Chats · {chats.length}
                </div>
                <div className="flex flex-col">
                  {chats.map((chat) => (
                    <ChatRow key={chat.id} chat={chat} phases={phases} onOpen={onOpenChat} />
                  ))}
                </div>
                <button type="button" onClick={onStart} className={`${GHOST} ${SMALL} mt-2`}>
                  <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
                  New chat
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniRow({
  phase,
  phases,
  chats,
  action,
  onOpenChat,
}: {
  phase: PlanPhase;
  phases: readonly PlanPhase[];
  chats: readonly HomeChat[];
  action: ReactNode;
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = `fork-mini-${phase.id}`;
  return (
    <div className="rounded-lg" data-phase={phase.id}>
      <div className="flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-content/5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Glyph status={phase.status} small />
          <span className="w-[22px] shrink-0 font-mono text-[11px] text-content/45">{phase.id}</span>
          <span
            className={`min-w-0 truncate text-[13px] ${
              phase.status === "done" ? "text-content/55" : "text-content/85"
            }`}
          >
            {phase.name}
          </span>
          {chats.length ? (
            <span className="shrink-0 text-[11px] tabular-nums text-content/40">
              {chats.length} {chats.length === 1 ? "chat" : "chats"}
            </span>
          ) : null}
        </button>
        {action}
      </div>
      <div
        id={bodyId}
        inert={!open || undefined}
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2.5 pb-3 pl-[46px] pr-2.5 pt-0.5 max-[620px]:pl-2.5">
            {phase.what ? (
              <p className="max-w-[62ch] text-[13px] leading-normal text-content/60">{phase.what}</p>
            ) : null}
            <Checks phase={phase} />
            {chats.length ? (
              <div>
                <div className="mb-1 text-[11px] font-medium text-content/45">Chats · {chats.length}</div>
                {chats.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} phases={phases} onOpen={onOpenChat} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function DoneGroup({
  phases,
  done,
  chats,
  onStatus,
  onOpenChat,
}: {
  phases: readonly PlanPhase[];
  done: readonly PlanPhase[];
  chats: readonly HomeChat[];
  onStatus: (phase: PlanPhase, status: PhaseStatus) => void;
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SubHeading label="Done" count={done.length} />
      {open ? (
        <div className={`${CARD} p-1`}>
          {done.map((phase) => (
            <MiniRow
              key={phase.id}
              phase={phase}
              phases={phases}
              chats={chats.filter((chat) => chat.phaseId === phase.id)}
              action={<StatusButton phase={phase} onPick={(status) => onStatus(phase, status)} />}
              onOpenChat={onOpenChat}
            />
          ))}
          <button
            type="button"
            aria-expanded
            onClick={() => setOpen(false)}
            className="w-full rounded-lg px-2.5 py-2 text-left text-[12px] text-content/45 hover:bg-content/5 hover:text-content"
          >
            Hide done phases
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className="flex w-full min-w-0 items-center gap-2.5 rounded-xl bg-content/4 px-4 py-3 text-left text-[13px] text-content/60 outline-none hover:bg-content/6 focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Glyph status="done" small />
          <span className="min-w-0 flex-1 truncate">{done.map((phase) => phase.name).join(", ")}</span>
          <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </>
  );
}

function LooseChip({ chat, phases }: { chat: HomeChat; phases: readonly PlanPhase[] }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={chat.activity ?? chat.last ?? chat.title}
        onClick={(event) => setMenu(event.currentTarget)}
        className="inline-flex h-[30px] max-w-full items-center gap-2 whitespace-nowrap rounded-lg border border-content/8 bg-content/5 pl-2 pr-2.5 text-[12.5px] text-content/85 outline-none transition-colors duration-150 hover:bg-content/9 focus-visible:ring-1 focus-visible:ring-accent"
      >
        <HarnessIcon harness={chat.harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 max-w-[260px] truncate">{chat.title}</span>
        <ChatStateLabel state={chat.state} />
      </button>
      {menu ? (
        <LinkMenu
          anchor={menu}
          chatId={chat.id}
          phases={phases}
          current={null}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

// --- All projects -------------------------------------------------------------

function AllProjects({
  projects,
  sessions,
  summaries,
  unseenIds,
  onOpenChat,
  onOpenProjectHome,
}: Props) {
  const local = useMemo(
    () => projects.filter((path) => path.startsWith("/")),
    [projects],
  );
  const plans = usePlans(local);
  const agents = useMemo(
    () => liveAgentsFromSessions(sessions, unseenIds),
    [sessions, unseenIds],
  );
  const updated = useMemo(
    () => new Map(summaries.map((summary) => [summary.id, summary.updatedAt])),
    [summaries],
  );
  const now = useNow();
  const needs = useMemo(
    () => needsItems(null, sessions, agents, updated, () => null),
    [sessions, agents, updated],
  );
  const working = agents.filter((agent) => !agent.needsApproval && !agent.done).length;
  const withPlan = local.filter((path) => plans.get(path)?.plan).length;
  return (
    <Page>
      <Header
        title="All projects"
        line={`What needs you across ${projects.length} ${projects.length === 1 ? "project" : "projects"}`}
      />
      <Stats>
        <Stat label="Needs you" value={needs.length} amber />
        <Stat label="Chats working" value={working} />
        <Stat label="With a roadmap" value={withPlan} of={local.length} />
      </Stats>
      <Section title="Needs you" count={needs.length} amber meta={needs.length > 1 ? "oldest first" : undefined}>
        <NeedsList
          items={needs}
          showProject
          empty="Nothing needs you. The chats are on it."
          now={now}
          onOpen={onOpenChat}
        />
      </Section>
      <FillPlans projects={local} plans={plans} />
      <Section title="Projects" count={projects.length}>
        <div className={`${CARD} flex flex-col p-1`}>
          {projects.map((path) => (
            <ProjectRow
              key={path}
              path={path}
              plan={plans.get(path)}
              working={agents.filter((agent) => sameProjectPath(agent.cwd, path) && !agent.done && !agent.needsApproval).length}
              waiting={needs.filter((item) => sameProjectPath(item.cwd, path)).length}
              onOpen={() => onOpenProjectHome(path)}
            />
          ))}
        </div>
      </Section>
    </Page>
  );
}

function planLine(state: PlanState | undefined): string {
  if (!state?.loaded) {
    return "";
  }
  const phases = state.plan?.phases;
  if (!phases?.length) {
    return "No plan yet";
  }
  const now = currentPhase(phases);
  const done = `${doneCount(phases)} of ${phases.length} done`;
  return now ? `Phase ${now.id} · ${now.name} · ${done}` : "All phases done";
}

function ProjectRow({
  path,
  plan,
  working,
  waiting,
  onOpen,
}: {
  path: string;
  plan: PlanState | undefined;
  working: number;
  waiting: number;
  onOpen: () => void;
}) {
  const label = useProjectLabel(path);
  const handoff = useHandoff(path);
  const line = planLine(plan);
  return (
    <button type="button" onClick={onOpen} className={ROW}>
      <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-content/6">
        <CurrentProjectIcon cwd={path} className="size-7" mascotClassName="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap text-[13.5px] font-medium text-content/92">
            {label}
          </span>
          <span className="min-w-0 truncate text-[12px] text-content/50">{line}</span>
        </span>
        {handoff?.heading || handoff?.line ? (
          <span className="mt-0.5 block truncate text-[12px] text-content/45">
            {handoff.heading || handoff.line}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
        {working ? (
          <span className="inline-flex items-center gap-1 text-accent" title={`${working} working`}>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {working}
          </span>
        ) : null}
        {waiting ? (
          <span className="text-amber-400" title={`${waiting} need you`}>
            {waiting} waiting
          </span>
        ) : null}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-content/30" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/**
 * Asks the projects without a usable roadmap to write or fill one, each in
 * a new background chat. The user picks which projects first.
 */
function FillPlans({
  projects,
  plans,
}: {
  projects: readonly string[];
  plans: ReadonlyMap<string, PlanState>;
}) {
  const needing = projects.filter((path) => {
    const state = plans.get(path);
    return state?.loaded && (!state.plan || !state.plan.hasStatusColumn);
  });
  const [open, setOpen] = useState(false);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [started, setStarted] = useState<number | null>(null);
  if (!needing.length && started === null) {
    return null;
  }
  const picked = needing.filter((path) => !skipped.has(path));
  const start = () => {
    let count = 0;
    for (const path of picked) {
      const state = plans.get(path);
      const id = launchHomeChat({
        cwd: path,
        prompt: fillPlanPrompt(state?.file ?? null),
        title: state?.plan ? "Fill the roadmap" : "Draft a roadmap",
        reveal: false,
      });
      if (id) {
        count += 1;
      }
    }
    setStarted(count);
    setOpen(false);
  };
  return (
    <section className={`${CARD} px-[18px] py-4`}>
      <div className="flex items-center gap-4 max-[620px]:flex-col max-[620px]:items-start">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">
            {started !== null
              ? `Started ${started} ${started === 1 ? "chat" : "chats"}`
              : `${needing.length} ${needing.length === 1 ? "project has" : "projects have"} no roadmap status`}
          </div>
          <div className="mt-1 text-[13px] leading-normal text-content/55">
            {started !== null
              ? "Each one fills its project's roadmap. Their homes update as they save."
              : "A chat in each one can write the phase table or fill its Status column, from the code and git log."}
          </div>
        </div>
        {started === null && !open ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
            className={GHOST}
          >
            <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
            Ask them to fill it
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 flex flex-col gap-3">
          <ul className="flex flex-col gap-px">
            {needing.map((path, index) => (
              <FillPick
                key={path}
                first={index === 0}
                path={path}
                state={plans.get(path)}
                checked={!skipped.has(path)}
                onToggle={() =>
                  setSkipped((was) => {
                    const next = new Set(was);
                    if (next.has(path)) {
                      next.delete(path);
                    } else {
                      next.add(path);
                    }
                    return next;
                  })
                }
              />
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <button type="button" disabled={!picked.length} onClick={start} className={SOLID}>
              Start {picked.length} {picked.length === 1 ? "chat" : "chats"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={GHOST}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FillPick({
  first,
  path,
  state,
  checked,
  onToggle,
}: {
  /** Takes focus when the list opens, since the button that opened it goes. */
  first: boolean;
  path: string;
  state: PlanState | undefined;
  checked: boolean;
  onToggle: () => void;
}) {
  const label = useProjectLabel(path);
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-content/5">
        <input
          type="checkbox"
          autoFocus={first}
          checked={checked}
          onChange={onToggle}
          className="size-3.5 shrink-0 accent-accent"
        />
        <CurrentProjectIcon cwd={path} className="size-4" mascotClassName="size-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-content/85">{label}</span>
        <span className="shrink-0 text-[12px] text-content/45">
          {state?.plan ? `Fill status in ${state.file}` : "Draft a roadmap"}
        </span>
      </label>
    </li>
  );
}

/** The clock for ages, ticking once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
