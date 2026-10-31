import { useEffect, useState } from "react";
import { useAgentActivity } from "../../backgroundAgents/runningAgents";
import { ActionButton, Felt, Sprite, TableFrame, reducedMotion } from "../table/kit";
import type { TableProps } from "../table/PokerTable";
import {
  COLS,
  DROP_ROWS,
  GARDEN_EVENT,
  SEEDS,
  SUN_ROWS,
  activityLine,
  bloomed,
  buy,
  loadGarden,
  plantRows,
  seedOf,
  seenSunshine,
  select,
  tend,
  tick,
  updateGarden,
  type GardenState,
  type Plant,
  type SeedKind,
} from "./garden";

/** Fork: the agent garden. Agents finish, the sun comes out, flowers grow. */

const LEAF = "#7fb77e";
const STEM = "#5d9a5f";
const SEED = "#b08a5a";
const SOIL = "color-mix(in srgb, #6b4f36 55%, var(--color-background-base))";
const SOIL_WET = "color-mix(in srgb, #4a3727 70%, var(--color-background-base))";
const FELT = "color-mix(in srgb, #7fb77e 12%, transparent)";
const SUN = "#f2cf5b";

function useGarden() {
  const [state, setState] = useState<GardenState>(() => loadGarden());
  useEffect(() => {
    const onChange = () => setState(loadGarden());
    window.addEventListener(GARDEN_EVENT, onChange);
    window.addEventListener("storage", onChange);
    // Quiet-time sunshine while the garden is open.
    updateGarden((current) => tick(current, Date.now()));
    const timer = setInterval(() => updateGarden((current) => tick(current, Date.now())), 30_000);
    return () => {
      window.removeEventListener(GARDEN_EVENT, onChange);
      window.removeEventListener("storage", onChange);
      clearInterval(timer);
    };
  }, []);
  return state;
}

function plantColors(plant: Plant) {
  const { colors } = seedOf(plant.kind);
  return { g: STEM, l: LEAF, s: SEED, p: colors.p!, c: colors.c! };
}

function Bed({ plant, index, onTend }: { plant: Plant | null; index: number; onTend: (index: number) => void }) {
  const ready = bloomed(plant);
  const label = !plant
    ? "Empty bed, plant a seed"
    : ready
      ? `${seedOf(plant.kind).name} in bloom, harvest`
      : `${seedOf(plant.kind).name}, stage ${plant.stage} of ${seedOf(plant.kind).stages}${plant.watered ? ", watered" : ", water it"}`;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-bed={index}
      data-bed-state={!plant ? "empty" : ready ? "bloom" : plant.watered ? "watered" : "growing"}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onTend(index)}
      className={`table-button relative grid size-[60px] cursor-pointer place-items-end justify-center rounded-sm pb-1 ${
        ready && !reducedMotion() ? "garden-sway" : ""
      }`}
      style={{ background: plant?.watered ? SOIL_WET : SOIL }}
    >
      {plant ? (
        <Sprite rows={plantRows(plant)} scale={5} colors={plantColors(plant)} />
      ) : (
        <span className="mb-4 font-mono text-[10px] text-content/35">+</span>
      )}
      {plant?.watered ? (
        <span className="absolute top-1 right-1" aria-hidden>
          <Sprite rows={DROP_ROWS} scale={1} colors={{ "#": "#8cc4e8" }} />
        </span>
      ) : null}
    </button>
  );
}

export function GardenTable({ active, onExit, onInput }: TableProps) {
  const state = useGarden();
  const activity = useAgentActivity();
  const [shown, setShown] = useState(0);

  // Show fresh sunshine for a moment, then mark it seen.
  useEffect(() => {
    if (state.sunshine <= 0) {
      return;
    }
    setShown(state.sunshine);
    updateGarden(seenSunshine);
  }, [state.sunshine]);

  // Its own timer: clearing the counter above mustn't cancel the fade.
  useEffect(() => {
    if (shown <= 0) {
      return;
    }
    const timer = setTimeout(() => setShown(0), 2400);
    return () => clearTimeout(timer);
  }, [shown]);

  const onTend = (index: number) => updateGarden((current) => tend(current, index));
  const onSeed = (kind: SeedKind) =>
    updateGarden((current) => (current.owned.includes(kind) ? select(current, kind) : buy(current, kind)));

  const onKey = (key: string) => {
    const index = Number(key) - 1;
    const seed = SEEDS[index];
    if (seed) {
      onSeed(seed.id);
    }
  };

  return (
    <TableFrame active={active} onKey={onKey} onExit={onExit} onInput={onInput} label="Agent garden">
      <div className="relative flex h-full flex-col items-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-3 top-1 bottom-[96px]"
          style={{ ["--table-felt" as string]: FELT }}
        >
          <Felt className="inset-0" />
        </div>

        <div className="relative z-10 flex h-8 shrink-0 items-center gap-2 pt-3 font-mono text-[10px] text-content/60">
          <span className={activity.working > 0 && !reducedMotion() ? "garden-pulse" : ""}>
            <Sprite rows={SUN_ROWS} scale={2} colors={{ "#": activity.working > 0 ? SUN : "currentColor" }} />
          </span>
          <span data-garden-line="">{activityLine(activity)}</span>
          {shown > 0 ? (
            <span role="status" className="text-[var(--table-win)]">
              +{shown} sun
            </span>
          ) : null}
        </div>

        <div
          className="relative z-10 mt-3 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${COLS}, 60px)` }}
          role="group"
          aria-label="Garden beds"
        >
          {state.beds.map((plant, index) => (
            <Bed key={index} plant={plant} index={index} onTend={onTend} />
          ))}
        </div>

        <div className="relative z-10 mt-auto flex flex-col items-center gap-2 pb-3">
          <span className="font-mono text-[10px] text-content/45">
            tap a bed to plant, water, or pick · watered plants grow twice as fast
          </span>
          <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Seeds">
            {SEEDS.map((seed, index) => {
              const owned = state.owned.includes(seed.id);
              const picked = owned && state.selected === seed.id;
              return (
                <ActionButton
                  key={seed.id}
                  primary={picked}
                  data-action={`seed-${seed.id}`}
                  disabled={!owned && state.petals < seed.price}
                  label={owned ? seed.name : `${seed.name} ${seed.price}p`}
                  keyHint={String(index + 1)}
                  onClick={() => onSeed(seed.id)}
                />
              );
            })}
          </div>
        </div>
      </div>
      <style>{GARDEN_CSS}</style>
    </TableFrame>
  );
}

const GARDEN_CSS = `
@keyframes garden-sway { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
.garden-sway > svg { animation: garden-sway 1.6s steps(2) infinite; }
@keyframes garden-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.garden-pulse { animation: garden-pulse 2.4s ease-in-out infinite; }
`;

/** Petals and blooms, for the panel's score row. */
export function GardenScore() {
  const [state, setState] = useState<GardenState>(() => loadGarden());
  useEffect(() => {
    const onChange = () => setState(loadGarden());
    window.addEventListener(GARDEN_EVENT, onChange);
    return () => window.removeEventListener(GARDEN_EVENT, onChange);
  }, []);
  return (
    <>
      <span data-fork-games-score={state.petals}>petals {state.petals}</span>
      <span className="text-content/35">blooms {state.blooms}</span>
    </>
  );
}
