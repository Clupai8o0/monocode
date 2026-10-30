import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  findModel,
  getModelSnapshot,
  isUltracodeOn,
  modelEffortSetting,
  subscribeModels,
  withUltracodeToggle,
} from "../../features/sessions/model/models";
import type { HarnessId } from "../../features/sessions/model/session";
import { subscribeEffortChanges } from "./effortAsk";
import "./EffortMeter.css";

/**
 * Fork feature: five bars beside a Claude session's model picker, filled to its
 * effort. They fill or drain a step at a time, and a chip says when the model
 * was the one that changed it. Clicking opens the picker, the manual control.
 */

const STEPS = ["low", "medium", "high", "xhigh", "max"];
const STEP_HEIGHTS = ["40%", "55%", "70%", "85%", "100%"];
const STEP_MS = 70;
const CHIP_MS = 1800;

/** How many bars this effort fills, or null for one the meter cannot show. */
export function effortMeterLevel(value: string | undefined): number | null {
  const index = value ? STEPS.indexOf(value.toLowerCase()) : -1;
  return index < 0 ? null : index + 1;
}

/**
 * The wait before each bar moves, so the change walks one step at a time: up
 * from the lowest changed bar, down from the highest.
 */
export function effortStepDelays(from: number, to: number): number[] {
  return STEPS.map((_, index) => {
    const bar = index + 1;
    if (to > from && bar > from && bar <= to) {
      return (bar - from - 1) * STEP_MS;
    }
    if (to < from && bar > to && bar <= from) {
      return (from - bar) * STEP_MS;
    }
    return 0;
  });
}

export function EffortMeter({
  sessionId,
  harness,
  model,
  values,
  busy,
}: {
  sessionId?: string;
  harness: HarnessId;
  model: string;
  values?: Record<string, string>;
  busy?: boolean;
}) {
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  const resolved = findModel(model);
  const setting = resolved && modelEffortSetting(resolved);
  const settings = resolved && values ? withUltracodeToggle(resolved, values) : values;
  const value = setting ? (settings?.[setting.id] ?? setting.value) : undefined;
  const level = effortMeterLevel(value);

  const shown = useRef(level);
  const delays = effortStepDelays(shown.current ?? 0, level ?? 0);
  useEffect(() => {
    shown.current = level;
  }, [level]);

  const [chip, setChip] = useState<{ key: number; text: string } | null>(null);
  useEffect(() => {
    setChip(null);
    if (!sessionId) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeEffortChanges((changed, change) => {
      if (changed !== sessionId) {
        return;
      }
      clearTimeout(timer);
      const arrow = change.direction === "raised" ? "↑" : "↓";
      setChip({ key: Date.now(), text: `${arrow} ${change.value}` });
      timer = setTimeout(() => setChip(null), CHIP_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId]);

  if (harness !== "claude" || !resolved || level === null) {
    return null;
  }
  const ultracode = isUltracodeOn(resolved, values);
  return (
    <button
      type="button"
      className="effort-meter"
      data-effort-meter=""
      data-level={STEPS[level - 1]}
      data-busy={busy ? "" : undefined}
      data-ultracode={ultracode ? "" : undefined}
      title={`Effort: ${value}${ultracode ? ", Ultracode on" : ""}`}
      aria-label={`Effort ${value}${ultracode ? ", Ultracode on" : ""}. Change effort`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.currentTarget.parentElement
          ?.querySelector<HTMLElement>("[data-fork-effort-target]")
          ?.click();
      }}
    >
      {STEPS.map((step, index) => (
        <span
          key={step}
          className="effort-meter-step"
          style={{ height: STEP_HEIGHTS[index] }}
        >
          <span
            className="effort-meter-fill"
            data-on={index < level ? "" : undefined}
            style={
              {
                "--effort-step": index,
                transitionDelay: `${delays[index]}ms`,
              } as CSSProperties
            }
          />
        </span>
      ))}
      {chip ? (
        <span
          key={chip.key}
          role="status"
          className="effort-meter-chip"
          style={{ "--effort-chip-ms": `${CHIP_MS}ms` } as CSSProperties}
        >
          {chip.text}
        </span>
      ) : null}
    </button>
  );
}
