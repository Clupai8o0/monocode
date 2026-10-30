import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { seeded } from "../seeded";
import { AGENTS, AGENT_IDS, pickLine, type AgentId, type ChatterEvent } from "./agents";
import { cardLabel, type Card } from "./cards";
import {
  AVATARS,
  CARD_BACK_DOTS,
  CARD_BACK_MARK,
  CARD_H,
  CARD_SHAPE,
  CARD_W,
  COIN,
  ICONS,
  cardInk,
  inkColor,
  rowsPath,
  type Rows,
} from "./sprites";
import { BUMP_TOKENS, formatTokens, rivalLine, tokenStore } from "./tokens";
import "./table.css";

/** Fork: what the three tables share: sprites, seats, chatter, keys, motion. */

const SEATS_KEY = "monocode.fork.games.seats";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

export function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** A session's dice. A test can fix them with `__MONOCODE_TABLE_SEED__`. */
export function tableSeed() {
  const fixed = (globalThis as { __MONOCODE_TABLE_SEED__?: number }).__MONOCODE_TABLE_SEED__;
  return fixed ?? Math.floor(Math.random() * 2 ** 31);
}

export function useRandom(salt: number) {
  const ref = useRef<ReturnType<typeof seeded> | null>(null);
  ref.current ??= seeded(tableSeed() + salt);
  return ref.current;
}

/** A sprite on its grid, scaled by whole numbers only. */
export function Sprite({
  rows,
  scale = 2,
  colors = { "#": "currentColor" },
  className,
  label,
}: {
  rows: Rows;
  scale?: number;
  colors?: Record<string, string>;
  className?: string;
  label?: string;
}) {
  const width = rows[0]!.length;
  const height = rows.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width * scale}
      height={height * scale}
      shapeRendering="crispEdges"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {Object.entries(colors).map(([char, fill]) => (
        <path key={char} d={rowsPath(rows, char)} fill={fill} />
      ))}
    </svg>
  );
}

const COIN_COLORS = { "#": "#e8b923", e: "#a97f12" };

export function Coin({ scale = 1 }: { scale?: number }) {
  return <Sprite rows={COIN} scale={scale} colors={COIN_COLORS} />;
}

export function Icon({ name, scale = 1 }: { name: keyof typeof ICONS; scale?: number }) {
  return <Sprite rows={ICONS[name]} scale={scale} />;
}

export const ShoeContext = createContext<RefObject<HTMLElement | null> | null>(null);

/** A card: `null` is face down. Slides in from the shoe when it first appears. */
export function PixelCard({
  card,
  scale = 2,
  delay = 0,
}: {
  card: Card | null;
  scale?: number;
  delay?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const shoe = useContext(ShoeContext);
  const faceUp = card !== null;
  const wasUp = useRef(faceUp);

  useLayoutEffect(() => {
    const el = ref.current;
    const from = shoe?.current;
    if (!el || !from || reducedMotion()) {
      return;
    }
    const start = from.getBoundingClientRect();
    const end = el.getBoundingClientRect();
    const x = Math.round(start.left - end.left);
    const y = Math.round(start.top - end.top);
    const motion = el.animate(
      [{ transform: `translate(${x}px, ${y}px)`, opacity: 0.5 }, { transform: "none", opacity: 1 }],
      { duration: 220, delay, easing: EASE_OUT, fill: "backwards" },
    );
    return () => motion.cancel();
    // Only on arrival; a flip isn't a deal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (faceUp && !wasUp.current && !reducedMotion()) {
      ref.current?.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 130, easing: "steps(3)" },
      );
    }
    wasUp.current = faceUp;
  }, [faceUp]);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      width={CARD_W * scale}
      height={CARD_H * scale}
      shapeRendering="crispEdges"
      role="img"
      aria-label={card === null ? "Face-down card" : cardLabel(card)}
      data-card={card === null ? "back" : cardLabel(card)}
      className="shrink-0"
    >
      <path
        d={rowsPath(CARD_SHAPE, "#")}
        fill={card === null ? "var(--table-back)" : "var(--table-card)"}
      />
      {card === null ? (
        <>
          <path d={rowsPath(CARD_BACK_DOTS, "#")} fill="var(--table-back-ink)" />
          <path d={rowsPath(CARD_BACK_MARK, "#")} fill="var(--color-content)" />
        </>
      ) : (
        <path d={rowsPath(cardInk(card), "#")} fill={inkColor(card)} />
      )}
    </svg>
  );
}

/** An empty place on the table where a card will land. */
export function CardSlot({ scale = 2 }: { scale?: number }) {
  return (
    <svg
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      width={CARD_W * scale}
      height={CARD_H * scale}
      shapeRendering="crispEdges"
      aria-hidden
      className="shrink-0"
    >
      <path d={rowsPath(CARD_SHAPE, "#")} fill="var(--table-slot)" />
    </svg>
  );
}

/** Swaps between two frames while something's happening. */
function useFrame(active: boolean) {
  const [frame, setFrame] = useState(false);
  useEffect(() => {
    if (!active || reducedMotion()) {
      setFrame(false);
      return;
    }
    const timer = setInterval(() => setFrame((value) => !value), 240);
    return () => clearInterval(timer);
  }, [active]);
  return frame;
}

export function Avatar({
  id,
  scale = 3,
  lively = false,
}: {
  id: AgentId;
  scale?: number;
  lively?: boolean;
}) {
  const frame = useFrame(lively);
  const frames = AVATARS[id];
  return (
    <span className={`inline-flex ${lively ? "table-hop" : ""}`} style={{ color: AGENTS[id].color }}>
      <Sprite rows={frame ? frames.talk : frames.rest} scale={scale} />
    </span>
  );
}

export function Bubble({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span
      key={text}
      className={`table-bubble pointer-events-none block w-max max-w-[150px] px-2 py-1 font-mono text-[10px] leading-[13px] text-content/90 ${className}`}
    >
      {text}
    </span>
  );
}

/** A stepped, filled shape behind the table: pixel corners and no rim. */
export function Felt({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute ${className}`}
      style={{ background: "var(--table-felt)", clipPath: FELT_SHAPE }}
    />
  );
}

/** Walks the outline clockwise, one stair at a time round each corner. */
const FELT_SHAPE = (() => {
  const step = 8;
  const insets = [7, 5, 3, 2, 1, 0];
  const rows = insets.map((inset, row) => ({
    x: inset * step,
    top: row * step,
    bottom: (row + 1) * step,
  }));
  const points: string[] = [];
  for (const { x, top, bottom } of [...rows].reverse()) {
    points.push(`${x}px ${bottom}px`, `${x}px ${top}px`);
  }
  for (const { x, top, bottom } of rows) {
    points.push(`calc(100% - ${x}px) ${top}px`, `calc(100% - ${x}px) ${bottom}px`);
  }
  for (const { x, top, bottom } of [...rows].reverse()) {
    points.push(
      `calc(100% - ${x}px) calc(100% - ${bottom}px)`,
      `calc(100% - ${x}px) calc(100% - ${top}px)`,
    );
  }
  for (const { x, top, bottom } of rows) {
    points.push(`${x}px calc(100% - ${top}px)`, `${x}px calc(100% - ${bottom}px)`);
  }
  return `polygon(${points.join(",")})`;
})();

export function ActionButton({
  label,
  keyHint,
  icon,
  onClick,
  disabled,
  primary,
  ...rest
}: {
  label: string;
  keyHint?: string;
  icon?: keyof typeof ICONS;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  "data-action"?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      {...rest}
      className={`table-button flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-2 font-mono text-[11px] disabled:cursor-default disabled:opacity-35 ${
        primary
          ? "bg-content/15 text-content hover:bg-content/25"
          : "bg-content/[0.07] text-content/85 hover:bg-content/15"
      }`}
    >
      {icon ? <Icon name={icon} /> : null}
      <span>{label}</span>
      {keyHint ? <span className="text-content/40">{keyHint}</span> : null}
    </button>
  );
}

type Bubbles = Partial<Record<AgentId, string>>;

/** Who's saying what. Each line clears itself. */
export function useChatter(random: () => number) {
  const [bubbles, setBubbles] = useState<Bubbles>({});
  const last = useRef<Partial<Record<AgentId, string>>>({});
  const timers = useRef<Partial<Record<AgentId, ReturnType<typeof setTimeout>>>>({});

  const say = useCallback(
    (id: AgentId, event: ChatterEvent, chance = 1) => {
      if (chance < 1 && random() > chance) {
        return;
      }
      const text = pickLine(AGENTS[id], event, random, last.current[id]);
      last.current[id] = text;
      setBubbles((current) => ({ ...current, [id]: text }));
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => {
        setBubbles((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }, 2800);
    },
    [random],
  );

  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of Object.values(held)) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { bubbles, say };
}

/** One of the seated agents passes on that someone is waiting for you. */
export function useCoworkerLine(
  waiting: number,
  seated: readonly AgentId[],
  say: (id: AgentId, event: ChatterEvent) => void,
  random: () => number,
) {
  const seen = useRef(waiting);
  useEffect(() => {
    if (waiting > seen.current && seated.length > 0) {
      say(seated[Math.floor(random() * seated.length)]!, "coworker");
    }
    seen.current = waiting;
  }, [waiting, seated, say, random]);
}

/** "Claude · thinking · 1.2k tokens", ticking up for as long as it's up. */
export function ThinkingLabel({ id }: { id: AgentId }) {
  const [count, setCount] = useState(180);
  useEffect(() => {
    const timer = setInterval(() => {
      setCount((value) => value + 40 + Math.floor(Math.random() * 90));
    }, 60);
    return () => clearInterval(timer);
  }, [id]);
  return (
    <span data-table-thinking={id} className="tabular-nums">
      {AGENTS[id].name} · thinking · {formatTokens(count)} tokens
    </span>
  );
}

/** Coins fly from one spot on the table to another, hopping once. */
export function flyCoins(
  root: HTMLElement | null,
  fromSelector: string,
  toSelector: string,
  count = 3,
) {
  if (!root || reducedMotion()) {
    return;
  }
  const from = root.querySelector(fromSelector);
  const to = root.querySelector(toSelector);
  if (!from || !to) {
    return;
  }
  const box = root.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const size = 8;
  const startX = Math.round(a.left + a.width / 2 - box.left);
  const startY = Math.round(a.top + a.height / 2 - box.top);
  const endX = Math.round(b.left + b.width / 2 - box.left);
  const endY = Math.round(b.top + b.height / 2 - box.top);
  for (let i = 0; i < count; i++) {
    const coin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    coin.setAttribute("viewBox", "0 0 8 8");
    coin.setAttribute("width", String(size));
    coin.setAttribute("height", String(size));
    coin.setAttribute("shape-rendering", "crispEdges");
    coin.setAttribute("aria-hidden", "true");
    coin.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;z-index:40`;
    coin.innerHTML = `<path d="${rowsPath(COIN, "#")}" fill="#e8b923"/><path d="${rowsPath(COIN, "e")}" fill="#a97f12"/>`;
    root.appendChild(coin);
    const midX = Math.round((startX + endX) / 2);
    const midY = Math.round(Math.min(startY, endY) - 14);
    const motion = coin.animate(
      [
        { transform: `translate(${startX}px, ${startY}px)` },
        { transform: `translate(${midX}px, ${midY}px)` },
        { transform: `translate(${endX}px, ${endY}px)` },
      ],
      { duration: 260, delay: i * 45, easing: "steps(8)", fill: "both" },
    );
    motion.onfinish = () => coin.remove();
    motion.oncancel = () => coin.remove();
  }
}

export type SeatMemo = {
  poker?: AgentId[];
  blackjack?: AgentId[];
  chess?: AgentId;
};

function loadSeats(): SeatMemo {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEATS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as SeatMemo) : {};
  } catch {
    return {};
  }
}

export function rememberSeats(change: SeatMemo) {
  try {
    localStorage.setItem(SEATS_KEY, JSON.stringify({ ...loadSeats(), ...change }));
  } catch {
    // Only a nicety; it picks fresh seats next time.
  }
}

export function knownAgents(ids: readonly unknown[] | undefined) {
  return (ids ?? []).filter((id): id is AgentId =>
    AGENT_IDS.includes(id as AgentId),
  );
}

export function recalledSeats() {
  return loadSeats();
}

export function useRivals() {
  return useSyncExternalStore(tokenStore.subscribe, tokenStore.rivals);
}

export function useBankroll() {
  return useSyncExternalStore(tokenStore.subscribe, tokenStore.bankroll);
}

/** Pick who sits. Tap to seat or unseat. */
export function SeatPicker({
  picked,
  max,
  onChange,
  single,
}: {
  picked: readonly AgentId[];
  max: number;
  onChange: (next: AgentId[]) => void;
  single?: boolean;
}) {
  const rivals = useRivals();
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Who sits at the table">
      {AGENT_IDS.map((id) => {
        const on = picked.includes(id);
        const full = !on && !single && picked.length >= max;
        return (
          <button
            key={id}
            type="button"
            tabIndex={-1}
            disabled={full}
            aria-pressed={on}
            aria-label={AGENTS[id].name}
            data-seat-pick={id}
            title={`${AGENTS[id].name}: ${rivalLine(AGENTS[id].name, rivals[id]?.net ?? 0)}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (single) {
                onChange([id]);
              } else {
                onChange(on ? picked.filter((item) => item !== id) : [...picked, id]);
              }
            }}
            className={`table-button grid size-6 cursor-pointer place-items-center rounded-sm disabled:cursor-default ${
              on ? "bg-content/10" : "opacity-40 hover:opacity-80"
            }`}
          >
            <Avatar id={id} scale={2} />
          </button>
        );
      })}
    </div>
  );
}

const BUMP_JOKES = [
  "Your account manager sighs and approves it.",
  "Support says this is the last one. They said that last time.",
  "Granted, after a brief survey about your usage.",
  "Quota raised. Please stop telling the agents.",
  "Approved by a form that nobody reads.",
  "Finance is looking the other way. For now.",
];

/** Out of tokens at this table: refill, with a joke. Play money only. */
export function QuotaBump({ needed }: { needed: number }) {
  const [joke, setJoke] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-2 font-mono text-[11px] text-content/70">
      <span>Not enough tokens for this table. It needs {formatTokens(needed)}.</span>
      <ActionButton
        primary
        label="Ask for a quota bump"
        data-action="bump"
        onClick={() => {
          tokenStore.add(BUMP_TOKENS);
          setJoke(BUMP_JOKES[Math.floor(Math.random() * BUMP_JOKES.length)]!);
        }}
      />
      {joke ? <span role="status">{joke}</span> : null}
    </div>
  );
}

/**
 * The board's own frame: holds focus, and takes keys only while it has focus.
 * Letters don't reach the app, where one could pull focus to the composer.
 */
export function TableFrame({
  active,
  onKey,
  onExit,
  onInput,
  label,
  children,
}: {
  active: boolean;
  onKey: (key: string) => void;
  onExit: () => void;
  onInput: () => void;
  label: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onKey, onExit, onInput });
  handlers.current = { onKey, onExit, onInput };

  useEffect(() => {
    if (active) {
      root.current?.focus();
    }
  }, [active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const el = root.current;
      const focus = document.activeElement;
      if (!el || !active || !(focus instanceof Node) || !el.contains(focus)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handlers.current.onExit();
        return;
      }
      if (event.key.length !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handlers.current.onInput();
      if (!event.repeat) {
        handlers.current.onKey(event.key === " " ? " " : event.key.toLowerCase());
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active]);

  return (
    <div
      ref={root}
      tabIndex={0}
      data-table-board={label}
      role="group"
      aria-label={label}
      onMouseDown={(event) => {
        // A press anywhere on the table keeps the keyboard here.
        if (!(event.target instanceof HTMLInputElement)) {
          event.preventDefault();
          root.current?.focus();
        }
      }}
      className="absolute inset-0 overflow-hidden outline-none select-none"
    >
      {children}
    </div>
  );
}
