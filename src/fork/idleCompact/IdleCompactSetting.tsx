import { useSyncExternalStore } from "react";
import {
  loadIdleCompactMode,
  saveIdleCompactMode,
  subscribeIdleCompact,
  type IdleCompactMode,
} from "./idleCompact";

const CHOICES: { id: IdleCompactMode; label: string; note: string }[] = [
  {
    id: "return",
    label: "When you return",
    note: "A Compact chip shows beside Send. Send summarises first; click it to keep the full history.",
  },
  {
    id: "before-expiry",
    label: "Before the cache runs out",
    note: "Summarises an idle thread about 5 minutes before its cache runs out, while that is still cheap. Falls back to the chip.",
  },
  {
    id: "never",
    label: "Never",
    note: "No chip, no automatic summary. Claude still compacts on its own when the context fills up.",
  },
];

/** Fork: Settings → Providers → Claude, how idle threads are compacted. */
export function IdleCompactSetting() {
  const mode = useSyncExternalStore(subscribeIdleCompact, loadIdleCompactMode);
  return (
    <section data-setting-id="idle-compact" id="setting-idle-compact" className="px-4 py-3 font-sans">
      <h3 className="text-[13px] font-medium text-content">Compact idle threads</h3>
      <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-content/50">
        Claude keeps a thread's history cached for about an hour. After that, the next message
        re-reads all of it at full price. For threads over 200K tokens, MonoCode can summarise first.
      </p>
      <div
        role="radiogroup"
        aria-label="Compact idle threads"
        className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-3"
      >
        {CHOICES.map((choice) => {
          const selected = mode === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => saveIdleCompactMode(choice.id)}
              className={`flex flex-col rounded-xl px-3 py-2.5 text-left transition-[background-color,transform] duration-150 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                selected ? "bg-accent/12" : "bg-content/[0.04] hover:bg-content/[0.07]"
              }`}
            >
              <span className={`block text-[13px] font-medium ${selected ? "text-content" : "text-content/75"}`}>
                {choice.label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-content/50">
                {choice.note}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
