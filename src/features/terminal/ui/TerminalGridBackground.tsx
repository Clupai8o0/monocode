import { useCallback, useEffect, useRef, useState } from "react";
import { HARNESS_ICONS, MONOCHROME_HARNESSES } from "../../sessions/ui/HarnessIcon";
import { MASCOT_GRID, PROJECT_MASCOTS } from "../../projects/model/projectMascots";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import {
  ARCADE_MODES,
  type ArcadeMode,
  type ArcadeSprite,
  type GridArcade,
} from "../arcade/gridArcade";
import {
  GRID_GAMES,
  SLIDE_HOLD_MS,
  stepSlider,
  type GridGame,
} from "../arcade/gridGames";
import { drawSpeechBubble } from "../../sessions/model/speechBubble";

const CELL = 6;
const GAP = 1;
const PITCH = CELL + GAP;
const BORDER_OPACITY = 0.06;
const PEAK_OPACITY = 0.72;
const LOGO_OPACITY = 0.7;
const BUBBLE_OPACITY = 0.9;
const PAC_OPACITY = 0.92;
const GHOST_OPACITY = 0.8;
/** Sprites sit inside their corridor rather than spilling over the walls. */
const SPRITE_SCALE = 0.8;
/** How hard the bubble chases its speaker; sprites move cell by cell. */
const BUBBLE_EASE = 0.2;
const FRAME_MS = 33;
/** The slide transition, plus a frame of slack, while both boards show. */
const SLIDE_MS = 800;
/** Fork: how often a paused host game repaints. */
const PAUSED_PAINT_MS = 250;
// Fork: less than one alpha byte of error, with no per-cell strings in paint.
const OPACITY_LEVELS = 1024;
/** After a game's code fails to load, how long before asking for it again. */
const LOAD_RETRY_MS = 5000;

function cellFills(rgb: string)
{
  return Array.from({ length: OPACITY_LEVELS + 1 }, (_, level) =>
    `rgba(${rgb}, ${level / OPACITY_LEVELS})`,
  );
}

const HEADING: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: 1 },
  d: { x: 1, y: 0 },
};

/**
 * Fork: a host (the games panel) that runs one board as a live game. It picks
 * the game, mode and pause, and draws its own controls around the board.
 */
export type GridGameHost = {
  gameId: string;
  mode: ArcadeMode;
  /** A new value starts a new game. */
  runId: number;
  paused: boolean;
  /** The panel is on screen, so the board may take focus. */
  active: boolean;
  onStats(score: number, lives: number, over: boolean): void;
  onExit(): void;
  onFocusChange(focused: boolean): void;
  /** Any key that reached the board, before the game sees it. */
  onInput(): void;
  /** Fork: P, before any game key. */
  onPauseKey?(): void;
  /** Fork: F, before any game key. */
  onFullscreenKey?(): void;
};

type Board = {
  game: GridGame;
  arcade: GridArcade;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  bubbleAt: { x: number; y: number } | null;
  cols: number;
  rows: number;
  started: boolean;
  width: number;
  height: number;
  dpr: number;
};

/**
 * Mascot art, traced once over its 8×8 box so each frame is a single fill.
 * Traced on first paint rather than at import, so nothing needs a canvas
 * around just to pull this module in.
 */
const mascotPaths = new Map<string, { rest: Path2D; talk: Path2D }>();

function mascotArt(name: string) {
  const cached = mascotPaths.get(name);
  if (cached) return cached;
  const mascot = PROJECT_MASCOTS.find((it) => it.name === name);
  if (!mascot) return null;
  const art = {
    rest: new Path2D(mascot.restPath),
    talk: new Path2D(mascot.talkPath),
  };
  mascotPaths.set(name, art);
  return art;
}

function parseRgb(value: string, fallback: string) {
  const match = value.match(/\d+/g);
  if (!match || match.length < 3) return fallback;
  return `${match[0]}, ${match[1]}, ${match[2]}`;
}

function parseContentRgb() {
  return parseRgb(getComputedStyle(document.body).color, "235, 238, 241");
}

function parseSurfaceRgb() {
  return parseRgb(
    getComputedStyle(document.body).backgroundColor,
    "20, 22, 25",
  );
}

/** A wedge-mouthed circle facing its heading; `mouth` 1 closes it out entirely. */
function drawPacman(
  ctx: CanvasRenderingContext2D,
  sprite: ArcadeSprite,
  fill: string,
) {
  const px = sprite.cx * PITCH + CELL / 2;
  const py = sprite.cy * PITCH + CELL / 2;
  const radius = (sprite.size * PITCH * SPRITE_SCALE) / 2;
  const facing = Math.atan2(sprite.dy, sprite.dx);
  const mouth = sprite.mouth * Math.PI;

  ctx.fillStyle = fill;
  ctx.beginPath();
  if (mouth <= 0.01) {
    ctx.arc(px, py, radius, 0, Math.PI * 2);
  } else {
    ctx.moveTo(px, py);
    ctx.arc(px, py, radius, facing + mouth, facing - mouth + Math.PI * 2);
    ctx.closePath();
  }
  ctx.fill();
}

/** The mascot's own pixel art, scaled up out of its 8×8 box. */
function drawGhost(
  ctx: CanvasRenderingContext2D,
  sprite: ArcadeSprite,
  fill: string,
) {
  const span = sprite.size * PITCH * SPRITE_SCALE;
  const left = sprite.cx * PITCH + CELL / 2 - span / 2;
  const top = sprite.cy * PITCH + CELL / 2 - span / 2;
  const unit = span / MASCOT_GRID;

  ctx.fillStyle = fill;
  if (sprite.eyes) {
    // Eaten: only the eyes float home, leaning the way they're headed.
    const lean = {
      x: Math.sign(sprite.dx) * unit * 0.6,
      y: Math.sign(sprite.dy) * unit * 0.6,
    };
    for (const offset of [2, 5]) {
      ctx.fillRect(
        left + offset * unit + lean.x,
        top + 3 * unit + lean.y,
        unit,
        unit * 1.5,
      );
    }
    return;
  }

  const art = sprite.mascot ? mascotArt(sprite.mascot) : null;
  if (!art) return;
  ctx.save();
  ctx.translate(left, top);
  ctx.scale(unit, unit);
  ctx.fill(sprite.frame === "talk" ? art.talk : art.rest);
  ctx.restore();
}

export function TerminalGridBackground({
  host,
}: { host?: GridGameHost } = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Fork: empty slots cost no canvas memory until their game is shown.
  const slotsRef = useRef<(HTMLDivElement | null)[]>([]);
  const invalidateRef = useRef<() => void>(() => {});
  const boardsRef = useRef<(Board | undefined)[] | null>(null);
  const indexRef = useRef(0);
  const playingRef = useRef(false);
  const scoreRef = useRef(0);
  const livesRef = useRef(0);
  const slideAtRef = useRef(0);
  // Fork: host mode.
  const hostRef = useRef(host);
  hostRef.current = host;
  const overRef = useRef(false);
  const heldRef = useRef(new Map<string, { x: number; y: number }>());
  // Fork: keys pressed before this game's code had loaded, played when it has.
  const missedRef = useRef(new Map<string, { x: number; y: number }>());
  const [loadFailed, setLoadFailed] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [playing, setPlaying] = useState(!!host);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  // Fork: a host draws the score itself, so the board doesn't re-render for it.
  const showScore = useCallback((next: number) => {
    scoreRef.current = next;
    const gameHost = hostRef.current;
    if (gameHost) {
      gameHost.onStats(next, livesRef.current, overRef.current);
    } else {
      setScore(next);
    }
  }, []);
  const [mode, setMode] = useState<ArcadeMode>("mid");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [slide, setSlide] = useState<{ index: number; dir: 1 | -1 }>({
    index: Math.max(0, GRID_GAMES.findIndex((item) => item.id === host?.gameId)),
    dir: 1,
  });
  const [hovered, setHovered] = useState(false);

  indexRef.current = slide.index;
  playingRef.current = playing;

  const game = GRID_GAMES[slide.index] ?? GRID_GAMES[0]!;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Fork: only visible games are imported and made; parked boards keep state.
    const boards: (Board | undefined)[] = [];
    const loading = new Set<number>();
    let disposed = false;
    let layoutDirty = true;
    let gridDirty = true;
    let dpr = 0;
    const retryAt = new Map<number, number>();
    boardsRef.current = boards;

    const logos = Object.fromEntries(
      HARNESSES.map((harness) => {
        const image = new Image();
        image.src = HARNESS_ICONS[harness];
        return [harness, image];
      }),
    ) as Record<HarnessId, HTMLImageElement>;
    const tintCanvas = document.createElement("canvas");
    const tintCtx = tintCanvas.getContext("2d");
    // The cell outlines never move, so they're stroked once here and
    // blitted each frame instead of thousands of strokeRects per paint.
    const gridCanvas = document.createElement("canvas");
    const gridCtx = gridCanvas.getContext("2d");

    let raf = 0;
    let cols = 0;
    let rows = 0;
    let width = 0;
    let height = 0;
    let stamp = new Float32Array(0);
    let rgb = parseContentRgb();
    let fills = cellFills(rgb);
    let surfaceRgb = parseSurfaceRgb();
    let lastFrame = 0;
    let lastPausedPaint = 0;

    const drawGrid = () => {
      if (!gridCtx || width <= 0 || height <= 0) return;
      const pixelWidth = Math.floor(width * dpr);
      const pixelHeight = Math.floor(height * dpr);
      if (gridCanvas.width !== pixelWidth) {
        gridCanvas.width = pixelWidth;
      }
      if (gridCanvas.height !== pixelHeight) {
        gridCanvas.height = pixelHeight;
      }
      gridCtx.setTransform(1, 0, 0, 1, 0, 0);
      gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridCtx.lineWidth = 1;
      gridCtx.strokeStyle = `rgba(${rgb}, ${BORDER_OPACITY})`;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          gridCtx.strokeRect(
            x * PITCH + 0.5,
            y * PITCH + 0.5,
            CELL - 1,
            CELL - 1,
          );
        }
      }
    };

    const onScreen = () => !document.hidden && (!hostRef.current || hostRef.current.active);
    const start = () => {
      if (raf || !onScreen()) {
        return;
      }
      raf = requestAnimationFrame(draw);
    };
    const invalidate = () => {
      layoutDirty = true;
      if (!raf) {
        lastFrame = 0;
      }
      start();
    };
    invalidateRef.current = invalidate;

    const ensureBoard = (index: number) => {
      const spec = GRID_GAMES[index];
      if (
        !spec || boards[index] || loading.has(index) ||
        performance.now() < (retryAt.get(index) ?? 0)
      ) {
        return;
      }
      loading.add(index);
      void spec.load().then((create) => {
        loading.delete(index);
        const slot = slotsRef.current[index];
        if (disposed || !create || !slot || index !== indexRef.current || !onScreen()) {
          return;
        }
        const rect = root.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return;
        }
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }
        canvas.className = "absolute inset-0 h-full w-full";
        canvas.setAttribute("aria-hidden", "true");
        const arcade = create();
        slot.appendChild(canvas);
        boards[index] = {
          game: spec, arcade, canvas, ctx, bubbleAt: null,
          cols: 0, rows: 0, started: false, width: 0, height: 0, dpr: 0,
        };
        retryAt.delete(index);
        setLoadFailed((failed) => (failed === index ? null : failed));
        invalidate();
      }).catch((error) => {
        loading.delete(index);
        // The draw loop asks every frame, so it waits a while before asking again.
        retryAt.set(index, performance.now() + LOAD_RETRY_MS);
        setLoadFailed(index);
        console.error("Could not load arcade", error);
      });
    };

    const layout = () => {
      layoutDirty = false;
      // Fork: not the bounding box. The panel opens on a scale animation, and no
      // resize fires when that ends, so a size read halfway through would stick.
      const nextWidth = root.clientWidth;
      const nextHeight = root.clientHeight;
      const nextDpr = window.devicePixelRatio || 1;
      if (nextWidth !== width || nextHeight !== height || nextDpr !== dpr) {
        width = nextWidth;
        height = nextHeight;
        dpr = nextDpr;
        cols = Math.ceil(width / PITCH);
        rows = Math.ceil(height / PITCH);
        gridDirty = true;
      }
    };

    const sizeBoard = (board: Board) => {
      if (board.width === width && board.height === height && board.dpr === dpr && board.started === playingRef.current) {
        return;
      }
      const pixelWidth = Math.floor(width * dpr);
      const pixelHeight = Math.floor(height * dpr);
      if (board.canvas.width !== pixelWidth) {
        board.canvas.width = pixelWidth;
      }
      if (board.canvas.height !== pixelHeight) {
        board.canvas.height = pixelHeight;
      }
      board.canvas.style.width = `${width}px`;
      board.canvas.style.height = `${height}px`;
      board.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (board.cols !== cols || board.rows !== rows) {
        board.arcade.resize(cols, rows);
        board.cols = cols;
        board.rows = rows;
      }
      board.width = width;
      board.height = height;
      board.dpr = dpr;
      if (!board.started && playingRef.current) {
        board.arcade.setMode(hostRef.current?.mode ?? modeRef.current);
        board.arcade.takeControl();
        // Fork: a key already down while this game's code loaded still counts.
        for (const [code, heading] of missedRef.current) {
          if (code === "Space") board.arcade.action?.();
          else board.arcade.steer(heading.x, heading.y);
        }
        missedRef.current.clear();
      }
      board.started = playingRef.current;
    };

    const paint = (board: Board, width: number, height: number) => {
      const { ctx, arcade } = board;
      const dim = arcade.controlled() ? 1 : board.game.idleDim;
      if (stamp.length === cols * rows) stamp.fill(0);
      else stamp = new Float32Array(cols * rows);
      arcade.stamp(stamp, cols, rows);

      const fade = arcade.fade();
      ctx.clearRect(0, 0, width, height);

      const peak = PEAK_OPACITY * dim;
      let lastLevel = -1;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const fillOpacity = (stamp[y * cols + x] ?? 0) * peak;
          if (fillOpacity > 0.02) {
            const level = Math.min(OPACITY_LEVELS, Math.round(fillOpacity * OPACITY_LEVELS));
            if (level !== lastLevel) {
              ctx.fillStyle = fills[level]!;
              lastLevel = level;
            }
            ctx.fillRect(x * PITCH, y * PITCH, CELL, CELL);
          }
        }
      }
      if (fade > 0 && gridCanvas.width > 0) {
        ctx.globalAlpha = fade;
        ctx.drawImage(gridCanvas, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }

      const pickup = arcade.logoPickup();
      const logo = pickup ? logos[pickup.harness] : null;
      if (pickup && logo?.complete && logo.naturalWidth) {
        const span = pickup.cells * PITCH - GAP;
        const dx = pickup.x * PITCH;
        const dy = pickup.y * PITCH;
        ctx.globalAlpha = pickup.alpha * LOGO_OPACITY * dim;
        if (MONOCHROME_HARNESSES.has(pickup.harness) && tintCtx) {
          const size = Math.max(1, Math.ceil(span));
          if (tintCanvas.width !== size || tintCanvas.height !== size) {
            tintCanvas.width = size;
            tintCanvas.height = size;
          } else {
            tintCtx.clearRect(0, 0, size, size);
          }
          tintCtx.globalCompositeOperation = "source-over";
          tintCtx.drawImage(logo, 0, 0, size, size);
          tintCtx.globalCompositeOperation = "source-in";
          tintCtx.fillStyle = `rgb(${rgb})`;
          tintCtx.fillRect(0, 0, size, size);
          ctx.drawImage(tintCanvas, dx, dy, span, span);
        } else {
          ctx.drawImage(logo, dx, dy, span, span);
        }
        ctx.globalAlpha = 1;
      }

      for (const sprite of arcade.sprites()) {
        const opacity =
          sprite.alpha *
          dim *
          (sprite.kind === "pacman" ? PAC_OPACITY : GHOST_OPACITY);
        if (opacity <= 0.02) continue;
        const fill = `rgba(${rgb}, ${opacity})`;
        if (sprite.kind === "pacman") drawPacman(ctx, sprite, fill);
        else drawGhost(ctx, sprite, fill);
      }

      const bubble = arcade.speechBubble();
      if (!bubble) {
        board.bubbleAt = null;
        return;
      }

      const target = { x: bubble.x * PITCH, y: bubble.y * PITCH };
      // Ease towards the speaker, but snap when they wrap through a tunnel
      // so the bubble doesn't sail across the whole canvas to catch up.
      const wrapped =
        board.bubbleAt && Math.abs(target.x - board.bubbleAt.x) > width / 3;
      board.bubbleAt =
        !board.bubbleAt || wrapped
          ? target
          : {
              x: board.bubbleAt.x + (target.x - board.bubbleAt.x) * BUBBLE_EASE,
              y: board.bubbleAt.y + (target.y - board.bubbleAt.y) * BUBBLE_EASE,
            };

      drawSpeechBubble(
        ctx,
        bubble.text,
        board.bubbleAt.x,
        board.bubbleAt.y,
        CELL,
        { width, height },
        bubble.alpha * BUBBLE_OPACITY * dim,
        { fg: `rgb(${rgb})`, bg: `rgb(${surfaceRgb})` },
      );
    };

    function draw(time: number)
    {
      raf = 0;
      if (!onScreen()) {
        lastFrame = 0;
        return;
      }
      const relayout = layoutDirty;
      if (layoutDirty) {
        layout();
      }
      if (width <= 0 || height <= 0) {
        return;
      }
      start();
      const current = indexRef.current;
      ensureBoard(current);
      const sliding = !playingRef.current && time - slideAtRef.current < SLIDE_MS;
      const visible = new Set([current]);
      if (sliding) {
        // Any board the track is carrying past the window, not only the last one.
        const rootBox = rootRef.current?.getBoundingClientRect();
        boards.forEach((board, i) => {
          const slot = board && slotsRef.current[i]?.getBoundingClientRect();
          if (slot && rootBox && slot.right > rootBox.left && slot.left < rootBox.right) {
            visible.add(i);
          }
        });
      }
      for (let i = 0; i < boards.length; i++) {
        const board = boards[i];
        if (board && visible.has(i)) {
          sizeBoard(board);
        }
      }
      if (gridDirty) {
        drawGrid();
        gridDirty = false;
      }
      if (!relayout && time - lastFrame < FRAME_MS) {
        return;
      }
      const dt = lastFrame ? time - lastFrame : FRAME_MS;
      lastFrame = time;
      const controlled = playingRef.current;
      const paused = hostRef.current?.paused;
      if (paused && !relayout && time - lastPausedPaint < PAUSED_PAINT_MS) {
        return;
      }
      if (paused) {
        lastPausedPaint = time;
      }
      for (let i = 0; i < boards.length; i++) {
        const board = boards[i];
        if (!board || (controlled && i !== current)) {
          continue;
        }
        if (!paused) {
          board.arcade.step(dt);
        }
        if (visible.has(i)) {
          paint(board, width, height);
        }
      }

      const active = boards[current];
      if (!active || !controlled) return;

      const nextScore = active.arcade.score();
      if (nextScore !== scoreRef.current) {
        showScore(nextScore);
      }
      const nextLives = active.arcade.lives();
      if (nextLives !== livesRef.current) {
        livesRef.current = nextLives;
        setLives(nextLives);
      }
      const nextOver = active.arcade.gameOver();
      if (nextOver !== overRef.current) {
        overRef.current = nextOver;
        setOver(nextOver);
      }
    }

    invalidate();

    const visibilityChanged = () => {
      lastFrame = 0;
      invalidate();
    };
    document.addEventListener("visibilitychange", visibilityChanged);

    const resizeObserver = new ResizeObserver(invalidate);
    resizeObserver.observe(root);

    const themeObserver = new MutationObserver(() => {
      const next = parseContentRgb();
      surfaceRgb = parseSurfaceRgb();
      if (next === rgb) return;
      rgb = next;
      fills = cellFills(rgb);
      gridDirty = true;
      invalidate();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      invalidateRef.current = () => {};
      for (const board of boards) {
        board?.canvas.remove();
      }
      document.removeEventListener("visibilitychange", visibilityChanged);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      boardsRef.current = null;
    };
  }, []);

  // Fork: every key still down lets go, so a jump or a run can't get stuck.
  const releaseHeld = useCallback(() => {
    const arcade = boardsRef.current?.[indexRef.current]?.arcade;
    for (const heading of heldRef.current.values()) {
      arcade?.steerEnd?.(heading.x, heading.y);
    }
    heldRef.current.clear();
    missedRef.current.clear();
  }, []);

  // Fork: the host's game and run decide what's on the board.
  const hostGameId = host?.gameId;
  const hostRunId = host?.runId;
  const lastHostRunRef = useRef(hostRunId);
  useEffect(() => {
    if (hostGameId === undefined) return;
    const boards = boardsRef.current;
    if (!boards) return;
    releaseHeld();
    const next = Math.max(
      0,
      GRID_GAMES.findIndex((item) => item.id === hostGameId),
    );
    const board = boards[next];
    indexRef.current = next;
    setSlide({ index: next, dir: 1 });
    board?.arcade.setMode(hostRef.current?.mode ?? "mid");
    if (board && hostRunId !== lastHostRunRef.current) {
      board.arcade.releaseControl();
      board.arcade.takeControl();
    }
    lastHostRunRef.current = hostRunId;
    scoreRef.current = board?.arcade.score() ?? 0;
    // Fork: a board still loading hasn't lost any lives.
    livesRef.current = board?.arcade.lives() ?? 3;
    overRef.current = board?.arcade.gameOver() ?? false;
    showScore(scoreRef.current);
    setLives(livesRef.current);
    setOver(overRef.current);
    invalidateRef.current();
    if (hostRef.current?.active) rootRef.current?.focus();
  }, [hostGameId, hostRunId, releaseHeld, showScore]);

  const hostMode = host?.mode;
  useEffect(() => {
    if (hostMode) {
      boardsRef.current?.[indexRef.current]?.arcade.setMode(hostMode);
    }
  }, [hostMode]);

  const hostActive = host?.active;
  useEffect(() => {
    if (hostActive) {
      rootRef.current?.focus();
    }
    invalidateRef.current();
  }, [hostActive]);

  // Fork: lives and game over reach the host here; the score goes in showScore.
  useEffect(() => {
    hostRef.current?.onStats(scoreRef.current, lives, over);
  }, [lives, over]);

  const takeControl = useCallback(() => {
    const board = boardsRef.current?.[indexRef.current];
    board?.arcade.setMode(mode);
    board?.arcade.takeControl();
    scoreRef.current = 0;
    livesRef.current = board?.arcade.lives() ?? 3;
    overRef.current = false;
    setOver(false);
    showScore(0);
    setLives(livesRef.current);
    setPlaying(true);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }, [mode, showScore]);

  const pickMode = useCallback((next: ArcadeMode) => {
    const board = boardsRef.current?.[indexRef.current];
    board?.arcade.setMode(next);
    setMode(next);
  }, []);

  const releaseControl = useCallback(() => {
    releaseHeld();
    boardsRef.current?.[indexRef.current]?.arcade.releaseControl();
    showScore(0);
    setPlaying(false);
  }, [releaseHeld, showScore]);

  useEffect(() => {
    slideAtRef.current = performance.now();
    invalidateRef.current();
  }, [slide.index]);

  const showGame = useCallback((next: number) => {
    if (next === indexRef.current) return;
    setSlide({
      index: next,
      dir: next > indexRef.current ? 1 : -1,
    });
  }, []);

  useEffect(() => {
    if (playing || hovered || GRID_GAMES.length < 2) return;

    const id = window.setInterval(() => {
      // A background tab has no layout box; don't re-render it to slide.
      if (document.hidden || !rootRef.current?.offsetParent) return;
      setSlide((current) =>
        stepSlider(current.index, current.dir, GRID_GAMES.length),
      );
    }, SLIDE_HOLD_MS);
    return () => window.clearInterval(id);
  }, [playing, hovered, slide.index]);

  useEffect(() => {
    if (!playing) return;

    const root = rootRef.current;
    root?.focus();
    const onWheel = (event: WheelEvent) => event.preventDefault();
    root?.addEventListener("wheel", onWheel, { passive: false });

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        return;
      }
      const active = document.activeElement;
      if (
        active !== root &&
        !(active instanceof Node && root?.contains(active))
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Fork: a host hides its panel instead of handing the board back.
        if (hostRef.current) hostRef.current.onExit();
        else releaseControl();
        return;
      }
      // Fork: a board made but not yet started ignores keys, so it waits like one
      // still loading.
      const board = boardsRef.current?.[indexRef.current];
      const arcade = board?.started ? board.arcade : undefined;
      const heading = HEADING[event.key] ?? HEADING[event.key.toLowerCase()];
      const isSpace = event.key === " ";
      // Fork: P pauses or resumes without playing a move.
      const pauseKey = hostRef.current?.onPauseKey;
      if ((event.key === "p" || event.key === "P") && pauseKey) {
        event.preventDefault();
        event.stopPropagation();
        // A held P toggles once.
        if (!event.repeat) pauseKey();
        return;
      }
      // Fork: F fills the panel, without playing a move.
      const fullscreenKey = hostRef.current?.onFullscreenKey;
      if ((event.key === "f" || event.key === "F") && fullscreenKey) {
        event.preventDefault();
        event.stopPropagation();
        // A held F toggles once.
        if (!event.repeat) fullscreenKey();
        return;
      }
      // Fork: while it's the board's turn, letters don't reach the app, where
      // one could pull focus to the composer and pause the game.
      if (hostRef.current && event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!heading && !isSpace) {
        if (hostRef.current && event.key.length === 1) hostRef.current.onInput();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Fork: a key that dismisses a pause doesn't also play a move.
      if (hostRef.current) {
        const wasPaused = hostRef.current.paused;
        hostRef.current.onInput();
        if (wasPaused) return;
      }
      if (isSpace) {
        if (event.repeat) return;
        heldRef.current.set(event.code, HEADING.ArrowUp!);
        if (arcade) arcade.action?.();
        else missedRef.current.set(event.code, HEADING.ArrowUp!);
        return;
      }
      if (heading) {
        heldRef.current.set(event.code, heading);
        if (arcade) arcade.steer(heading.x, heading.y);
        else missedRef.current.set(event.code, heading);
      }
    };

    // Fork: held movement needs to hear the key come back up.
    const onKeyUp = (event: KeyboardEvent) => {
      const heading = heldRef.current.get(event.code);
      if (!heading) return;
      heldRef.current.delete(event.code);
      missedRef.current.delete(event.code);
      event.preventDefault();
      event.stopPropagation();
      boardsRef.current?.[indexRef.current]?.arcade.steerEnd?.(
        heading.x,
        heading.y,
      );
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", releaseHeld);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", releaseHeld);
      root?.removeEventListener("wheel", onWheel);
    };
  }, [playing, releaseControl, releaseHeld]);

  // Fork: focus decides pause. The board holds focus when the window does, and
  // loses it for the composer, another window, or a click elsewhere.
  const hosted = !!host;
  useEffect(() => {
    if (!hosted) return;
    const root = rootRef.current;
    if (!root) return;
    const report = () =>
      hostRef.current?.onFocusChange(
        document.hasFocus() && document.activeElement === root,
      );
    const onBlur = () => {
      releaseHeld();
      hostRef.current?.onFocusChange(false);
    };
    root.addEventListener("focus", report);
    root.addEventListener("blur", onBlur);
    window.addEventListener("focus", report);
    window.addEventListener("blur", onBlur);
    report();
    return () => {
      root.removeEventListener("focus", report);
      root.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", onBlur);
    };
  }, [hosted, releaseHeld]);

  return (
    <div
      ref={rootRef}
      tabIndex={playing ? 0 : -1}
      data-grid-board=""
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onMouseDown={() => {
        if (playing) rootRef.current?.focus();
      }}
      aria-label={playing ? game.playLabel : undefined}
      className={
        playing
          ? "absolute inset-0 z-20 overflow-hidden bg-background-base outline-none"
          : "group pointer-events-auto absolute inset-x-0 top-0 z-0 h-48"
      }
    >
      <div
        className={
          playing
            ? "absolute inset-0 overflow-hidden"
            : "absolute inset-0 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_65%,transparent_100%)]"
        }
      >
        <div
          className={`flex h-full motion-reduce:transition-none ${
            playing ? "" : "transition-transform duration-700 ease-in-out"
          }`}
          style={{ transform: `translateX(-${slide.index * 100}%)` }}
        >
          {GRID_GAMES.map((item, i) => (
            <div
              key={item.id}
              ref={(el) => { slotsRef.current[i] = el; }}
              data-grid-game={item.id}
              className="relative h-full w-full min-w-full shrink-0"
            />
          ))}
        </div>
      </div>

      {host && loadFailed === slide.index ? (
        <p
          data-grid-load-failed=""
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-[12px] text-content/55"
        >
          This game didn't load. Trying again.
        </p>
      ) : null}

      {host ? null : playing ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-3 items-center px-3 py-2 font-mono text-[11px] tracking-[0.14em] text-content/50">
          <span>
            score {score}
            {game.lives ? (
              <span className="ml-3 text-content/35">
                {lives > 0 ? "•".repeat(lives) : "game over"}
              </span>
            ) : null}
            {/* Fork: Space restarts these once they've ended. */}
            {game.hasAction && over ? (
              <span className="ml-3 text-content/70">
                game over · space to retry
              </span>
            ) : null}
          </span>
          <div className="pointer-events-auto flex justify-center gap-1">
            {ARCADE_MODES.map((id) => {
              const on = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  tabIndex={-1}
                  aria-pressed={on}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickMode(id)}
                  className={`cursor-pointer border px-2 py-1 ${
                    on
                      ? "border-content/40 bg-content/10 text-content"
                      : "border-content/10 text-content/40 hover:border-content/25 hover:text-content/70"
                  }`}
                >
                  {id}
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              tabIndex={-1}
              onClick={releaseControl}
              className="pointer-events-auto cursor-pointer border border-content/20 bg-background-base/70 px-2 py-1 text-content/70 hover:border-content/40 hover:text-content"
            >
              <span className="text-content/35">[</span> release{" "}
              <span className="text-content/35">]</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={takeControl}
              className="pointer-events-none flex cursor-pointer items-center gap-2 border border-content/25 bg-background-base/80 px-3 py-1.5 font-mono text-[11px] tracking-[0.16em] text-content/85 shadow-lg backdrop-blur-sm group-hover:pointer-events-auto hover:border-content/45 hover:bg-content/10 hover:text-content"
            >
              <span className="text-content/40">[</span>
              take control
              <span className="text-content/25">·</span>
              {game.label}
              <span
                className="inline-block h-3 w-1.5 bg-content/75 motion-safe:group-hover:animate-pulse"
                aria-hidden
              />
              <span className="text-content/40">]</span>
            </button>
          </div>
          {GRID_GAMES.length > 1 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 flex justify-center">
              {GRID_GAMES.map((item, i) => {
                const on = i === slide.index;
                return (
                  <button
                    key={item.id}
                    type="button"
                    tabIndex={-1}
                    aria-label={item.label}
                    aria-pressed={on}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => showGame(i)}
                    className="pointer-events-auto flex h-4 w-4 cursor-pointer items-center justify-center"
                  >
                    <span
                      className={`block h-1.5 w-1.5 ${
                        on
                          ? "bg-content/45"
                          : "bg-content/15 hover:bg-content/30"
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
