import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  COIN_EDGE_PATH,
  COIN_FACE_PATH,
  COIN_HOVER,
  COIN_SIZE,
  COLLECT_POP_MS,
  COLLECT_POP_PX,
  EXIT_MS,
  EXIT_SINK,
  STAR_COUNT,
  STAR_EDGE_PATH,
  STAR_FACE_PATH,
  STAR_SIZE,
  coinCollected,
  exitJumpY,
  hitsChevron,
  jumpHeight,
  nextCoinDelay,
  obstacleFromRects,
  pickCoinX,
  RUNNER_INSET,
  RUNNER_SIZE,
  RUNNER_SPEED_PX,
  poseAt,
  recoilAlong,
  scaleTrackX,
  stepAlong,
  runnerTrack,
  spriteClipBottom,
  stunDone,
  stunShake,
  stunStars,
  type Coin,
  type Obstacle,
  type RunnerTrack,
} from "../model/composerRunner";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { projectMascot } from "../../projects/model/projectMascots";
// Fork
import {
  FORK_RUNNER_PLAY,
  INERT_RUNNER_PLAY,
  PLAY_NO_CLIP_PX,
  createRunnerPlay,
} from "../../../fork/runnerPlay/runnerPlayController";

type Props = {
  boxRef: RefObject<HTMLElement | null>;
  cwd: string;
  busy: boolean;
  enabled?: boolean;
  onExited: () => void;
};

type LiveCoin = Coin & {
  el: HTMLDivElement;
  collectedAt: number | null;
};

const COIN_SVG = `<svg viewBox="0 0 8 8" width="${COIN_SIZE}" height="${COIN_SIZE}" shape-rendering="crispEdges" fill="#e8b923" aria-hidden="true"><path class="composer-coin-face" d="${COIN_FACE_PATH}"/><path class="composer-coin-edge" d="${COIN_EDGE_PATH}"/></svg>`;
const STAR_SVG = `<svg viewBox="0 0 8 8" width="${STAR_SIZE}" height="${STAR_SIZE}" shape-rendering="crispEdges" fill="#f4e27a" aria-hidden="true"><path class="composer-coin-face" d="${STAR_FACE_PATH}"/><path class="composer-coin-edge" d="${STAR_EDGE_PATH}"/></svg>`;
const GEOMETRY_SAMPLE_MS = 100;

/** Project pixel mascot running the composer's top ledge while a turn is live. */
export function ComposerRunner({
  boxRef,
  cwd,
  busy,
  enabled = true,
  onExited,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  const coinsRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null); // Fork
  const busyRef = useRef(busy);
  const enabledRef = useRef(enabled);
  const onExitedRef = useRef(onExited);
  const wakeRef = useRef(() => {});
  busyRef.current = busy;
  enabledRef.current = enabled;
  onExitedRef.current = onExited;

  const project = projectName(cwd);
  const key = projectKey(cwd);
  const appearance = useMemo(() => {
    return {
      name: resolveTabGroupMascot(key, loadTabGroupMascots()),
      color: resolveTabGroupColor(
        key,
        loadTabGroupColors(),
        loadTabGroupCustomColors(),
        project,
      ),
    };
  }, [key, project]);
  // Fork: what the play controller needs to draw over the sprite.
  const mascotRef = useRef({ project, appearance });
  mascotRef.current = { project, appearance };

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const sprite = spriteRef.current;
    const coinLayer = coinsRef.current;
    const starLayer = starsRef.current;
    if (!layer || !sprite || !coinLayer || !starLayer) return;

    let along = 0;
    let facing: 1 | -1 = 1;
    let prevWidth = 0;
    let last = performance.now();
    let raf = 0;
    let parked = false;
    let coinId = 0;
    let nextCoinAt = last + nextCoinDelay(true);
    let exiting = false;
    let exitAt = 0;
    let frozenX = 0;
    let frozenFacing: 1 | -1 = 1;
    let finished = false;
    let stunning = false;
    let stunAt = 0;
    let hitAlong = 0;
    let hitFacing: 1 | -1 = 1;
    let geometryAt = -Infinity;
    let geometryBox: HTMLElement | null = null;
    let cachedTrack: RunnerTrack | null = null;
    let cachedObstacle: Obstacle | null = null;
    const coins: LiveCoin[] = [];
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let learned = reduced;
    // Fork: picking it up, throwing it, petting it. See src/fork/runnerPlay.
    const body = bodyRef.current;
    const play =
      FORK_RUNNER_PLAY && body
        ? createRunnerPlay({
            layer,
            body,
            reduced,
            mascotRows: () => {
              const { project, appearance } = mascotRef.current;
              return projectMascot(project, appearance.name).rest;
            },
            color: () => mascotRef.current.appearance.color,
          })
        : INERT_RUNNER_PLAY;
    let playStun = false; // Fork: a stun from a landing teaches nothing.
    const starEls = Array.from({ length: STAR_COUNT }, () => {
      const el = document.createElement("div");
      el.className = "absolute top-0 left-0";
      el.style.width = `${STAR_SIZE}px`;
      el.style.height = `${STAR_SIZE}px`;
      el.style.opacity = "0";
      el.style.filter = "drop-shadow(0 1px 0 rgba(0,0,0,0.45))";
      el.style.transform =
        "translate3d(var(--star-x, -64px), var(--star-y, -64px), 0)";
      el.innerHTML = STAR_SVG;
      starLayer.append(el);
      return el;
    });

    // Not `visibility: hidden`: the sprites' looping CSS animations would
    // keep running behind it.
    const showLayer = (shown: boolean) => {
      layer.style.display = shown ? "" : "none";
    };
    showLayer(false);

    const placeSprite = (
      boxLeft: number,
      boxTop: number,
      x: number,
      y: number,
      facing: 1 | -1,
      shakeX = 0,
      shakeY = 0,
    ) => {
      sprite.style.setProperty(
        "--runner-x",
        `${Math.round(boxLeft + x - RUNNER_SIZE / 2 + shakeX)}px`,
      );
      sprite.style.setProperty(
        "--runner-y",
        `${Math.round(boxTop - RUNNER_SIZE - y + 1 + shakeY)}px`,
      );
      sprite.style.setProperty("--runner-facing", String(facing));
      // Fork: don't sink-clip it while it's in the air or in hand.
      sprite.style.setProperty(
        "--runner-clip",
        `${play.offLedge() ? PLAY_NO_CLIP_PX : spriteClipBottom(y)}px`,
      );
      play.placeHit(
        Math.round(boxLeft + x - RUNNER_SIZE / 2 + shakeX),
        Math.round(boxTop - RUNNER_SIZE - y + 1 + shakeY),
      );
    };

    const hideStars = () => {
      for (const el of starEls) el.style.opacity = "0";
    };

    const placeStars = (
      boxLeft: number,
      boxTop: number,
      x: number,
      y: number,
      elapsed: number,
      shakeX = 0,
      shakeY = 0,
    ) => {
      const spriteLeft = boxLeft + x - RUNNER_SIZE / 2 + shakeX;
      const spriteTop = boxTop - RUNNER_SIZE - y + 1 + shakeY;
      const poses = stunStars(elapsed);
      for (let i = 0; i < starEls.length; i++) {
        const el = starEls[i];
        const star = poses[i];
        if (!star) {
          el.style.opacity = "0";
          continue;
        }
        el.style.setProperty(
          "--star-x",
          `${Math.round(spriteLeft + star.dx)}px`,
        );
        el.style.setProperty(
          "--star-y",
          `${Math.round(spriteTop + star.dy)}px`,
        );
        el.style.opacity = String(star.opacity);
      }
    };

    const endStun = () => {
      stunning = false;
      playStun = false; // Fork
      sprite.classList.remove("mascot-stunned");
      hideStars();
    };

    const clearCoins = () => {
      for (const coin of coins) coin.el.remove();
      coins.length = 0;
    };

    const apply = (now: number) => {
      const dt = Math.min(now - last, 48);
      last = now;

      const box = boxRef.current;
      if (!enabledRef.current) {
        showLayer(false);
        endStun();
        play.stop(now); // Fork
        if (!busyRef.current && !finished) {
          finished = true;
          clearCoins();
          onExitedRef.current();
        }
        // A pane in a background tab is disabled and stops re-rendering, so
        // `busy` can't change until the tab is shown. Draw no frames until
        // a prop does.
        parked = true;
        return;
      }
      if (!box || document.hidden) {
        showLayer(false);
        return;
      }

      // Reading layout every animation frame forces WebKit to flush changes
      // when a new transcript block arrives. The runner can animate from the
      // last measured track while geometry is refreshed at a lower rate.
      if (box !== geometryBox || now - geometryAt >= GEOMETRY_SAMPLE_MS) {
        const shell = box.closest("[data-composer]");
        const review = shell?.querySelector("[data-session-review]");
        const queue = shell?.querySelector("[data-message-queue-card]");
        const ledge = review ?? queue;
        cachedTrack = runnerTrack(
          box.getBoundingClientRect(),
          ledge?.getBoundingClientRect() ?? null,
        );
        const pane = box.closest("[data-session-drop]");
        const button = pane?.querySelector("[data-jump-to-bottom]");
        cachedObstacle = obstacleFromRects(
          {
            left: cachedTrack.left,
            right: cachedTrack.left + cachedTrack.width,
            top: cachedTrack.top,
            bottom: cachedTrack.top + 8,
            width: cachedTrack.width,
          },
          button?.getBoundingClientRect() ?? null,
        );
        geometryBox = box;
        geometryAt = now;
      }
      const track = cachedTrack;
      if (!track) return;
      if (track.width <= 0) {
        showLayer(false);
        return;
      }
      showLayer(true);

      const insetTrack = Math.max(0, track.width - RUNNER_INSET * 2);
      if (prevWidth > 0 && prevWidth !== track.width) {
        const prevInset = Math.max(0, prevWidth - RUNNER_INSET * 2);
        along = scaleTrackX(along, prevInset, insetTrack);
        hitAlong = scaleTrackX(hitAlong, prevInset, insetTrack);
        frozenX = scaleTrackX(frozenX, prevWidth, track.width);
        for (const coin of coins) {
          coin.x = scaleTrackX(coin.x, prevWidth, track.width);
        }
      }
      prevWidth = track.width;

      if (busyRef.current) {
        if (exiting) {
          exiting = false;
          learned = reduced;
          endStun();
        }
        finished = false;
        if (!reduced && !stunning) {
          // Fork: play sets the pace (0 while it's being held or petted).
          const stepped = stepAlong(
            along,
            facing,
            dt,
            insetTrack,
            RUNNER_SPEED_PX * play.speed(now),
          );
          along = stepped.along;
          facing = stepped.facing;
        }
      } else if (!exiting && !finished && !play.settling()) {
        // Fork: settling above: it comes down first if it's held or in the air.
        exiting = true;
        exitAt = now;
        endStun();
        play.stop(now); // Fork
        const current = poseAt(along, facing, track.width, null, []);
        frozenX = current.x;
        frozenFacing = current.facing;
        for (const coin of coins) {
          if (coin.collectedAt == null) coin.collectedAt = now;
        }
      }

      if (exiting) {
        const t = reduced ? 1 : Math.min(1, (now - exitAt) / EXIT_MS);
        const y = reduced ? -EXIT_SINK : exitJumpY(t);
        play.stop(now); // Fork: lets the last effects fade.
        placeSprite(track.left, track.top, frozenX, y, frozenFacing);
        for (const coin of [...coins]) {
          const pop = Math.min(1, (now - (coin.collectedAt ?? now)) / COLLECT_POP_MS);
          coin.el.style.opacity = String(1 - pop);
          if (pop >= 1) {
            coin.el.remove();
            coins.splice(coins.indexOf(coin), 1);
          }
        }
        if (t >= 1 && !finished) {
          finished = true;
          clearCoins();
          onExitedRef.current();
        }
        return;
      }

      const obstacle = cachedObstacle;
      if (stunning) {
        along = recoilAlong(hitAlong, hitFacing, now - stunAt, insetTrack);
        facing = hitFacing;
        if (stunDone(now - stunAt)) {
          // Fork: a shake earns more rounds of stars; a landing teaches nothing.
          if (play.staysDizzy()) {
            stunAt = now;
            hitAlong = along;
          } else {
            learned ||= !playStun;
            endStun();
          }
        }
      }

      for (const coin of coins) {
        if (
          coin.collectedAt == null &&
          (coin.x < RUNNER_INSET || coin.x > track.width - RUNNER_INSET)
        ) {
          coin.collectedAt = now;
        }
      }
      // Keep grabbed coins in the pose so the hop finishes instead of snapping
      // back to the rim the frame they are collected. Skip the chevron hop
      // until the mascot has bonked it once this turn.
      // Fork: play may lift it off the ledge or override the pose. No chevron
      // arc while stunned: a landing can stun it right under one.
      const pose = play.frame(
        now,
        dt,
        poseAt(
          along,
          facing,
          track.width,
          learned && !stunning ? obstacle : null,
          stunning ? [] : coins,
        ),
        track,
        obstacle,
        busyRef.current,
        stunning,
      );
      // Fork: back on the ledge, and maybe stunned by it.
      const landed = play.takeLanding();
      if (landed) {
        along = landed.along;
        if (landed.stun) {
          stunning = true;
          stunAt = now;
          hitAlong = along;
          hitFacing = facing;
          playStun = landed.stun !== "bonk";
          sprite.classList.add("mascot-stunned");
        }
      }
      if (stunning && play.offLedge()) endStun(); // Fork
      if (
        !stunning &&
        !play.offLedge() && // Fork
        hitsChevron(pose.x, pose.y, pose.facing, obstacle, learned)
      ) {
        stunning = true;
        stunAt = now;
        hitAlong = along;
        hitFacing = facing;
        sprite.classList.add("mascot-stunned");
      }
      const shake = stunning ? stunShake(now - stunAt) : { x: 0, y: 0 };
      if (stunning) {
        placeStars(
          track.left,
          track.top,
          pose.x,
          pose.y,
          now - stunAt,
          shake.x,
          shake.y,
        );
      } else {
        hideStars();
      }
      const hasLive = coins.some((coin) => coin.collectedAt == null);

      if (
        !reduced &&
        !stunning &&
        !hasLive &&
        now >= nextCoinAt &&
        busyRef.current // Fork: not while it settles after the turn.
      ) {
        const x = pickCoinX(track.width, pose.x, obstacle);
        if (x != null) {
          const el = document.createElement("div");
          el.className = "absolute top-0 left-0";
          el.style.width = `${COIN_SIZE}px`;
          el.style.height = `${COIN_SIZE}px`;
          el.style.transform =
            "translate3d(var(--coin-x, -64px), var(--coin-y, -64px), 0)";
          el.style.filter = "drop-shadow(0 1px 0 rgba(0,0,0,0.45))";
          el.innerHTML = COIN_SVG;
          coinLayer.append(el);
          coins.push({
            id: ++coinId,
            x,
            height: COIN_HOVER,
            el,
            collectedAt: null,
          });
        } else {
          nextCoinAt = now + 2000;
        }
      }

      for (const coin of [...coins]) {
        if (
          !stunning &&
          coin.collectedAt == null &&
          coinCollected(pose, coin)
        ) {
          coin.collectedAt = now;
          nextCoinAt = now + nextCoinDelay(false);
          if (play.coinTaken(now)) coin.el.style.visibility = "hidden"; // Fork
        }

        const bob =
          coin.collectedAt == null ? Math.sin(now / 180) * 2 : 0;
        const pop =
          coin.collectedAt == null
            ? 0
            : Math.min(1, (now - coin.collectedAt) / COLLECT_POP_MS);
        coin.el.style.setProperty(
          "--coin-x",
          `${Math.round(track.left + coin.x - COIN_SIZE / 2)}px`,
        );
        coin.el.style.setProperty(
          "--coin-y",
          `${Math.round(track.top - coin.height - COIN_SIZE / 2 - bob - COLLECT_POP_PX * pop)}px`,
        );
        coin.el.style.opacity = String(1 - pop);
        if (pop >= 1) coin.el.remove();
        if (pop >= 1 && jumpHeight(pose.x, null, [coin]) <= 0.5) {
          coins.splice(coins.indexOf(coin), 1);
        }
      }

      placeSprite(
        track.left,
        track.top,
        pose.x,
        pose.y,
        pose.facing,
        shake.x,
        shake.y,
      );
    };

    apply(last);
    const tick = (now: number) => {
      apply(now);
      if (!parked) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    wakeRef.current = () => {
      if (!parked) return;
      parked = false;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    return () => {
      cancelAnimationFrame(raf);
      clearCoins();
      showLayer(false);
      play.destroy(); // Fork
    };
  }, [boxRef]);

  useEffect(() => wakeRef.current(), [busy, enabled]);

  return createPortal(
    <div
      ref={layerRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40 overflow-visible"
      style={{ display: "none" }}
    >
      <div ref={coinsRef} className="absolute inset-0" />
      <div
        ref={spriteRef}
        className="absolute top-0 left-0 origin-bottom drop-shadow-[0_1px_0_rgba(0,0,0,0.45)] will-change-transform"
        style={{
          width: RUNNER_SIZE,
          height: RUNNER_SIZE,
          transform:
            "translate3d(var(--runner-x, -64px), var(--runner-y, -64px), 0) scaleX(var(--runner-facing, 1))",
          // Fork: only the bottom sinks; a flip or kick may leave the box.
          clipPath: "inset(-24px -24px var(--runner-clip, 0px) -24px)",
        }}
      >
        {/* Fork: a wrapper the play controller turns, squashes and dresses. */}
        <div ref={bodyRef} style={{ position: "relative", width: RUNNER_SIZE, height: RUNNER_SIZE }}>
          <ProjectMascot
            project={project}
            name={appearance.name}
            color={appearance.color}
            className="size-4"
            active
          />
        </div>
      </div>
      <div ref={starsRef} className="absolute inset-0" />
    </div>,
    document.body,
  );
}
