import { useEffect, useState, type ReactNode } from "react";
import { playCue } from "../../features/settings/model/sounds";
import { copyText } from "../../platform/tauri/clipboard";
import { Check, Copy } from "../../shared/ui/icons";

/**
 * Fork: Home lab, the small pieces the settings section and the footer
 * popover share: a switch, a settings block, a segmented choice, a copy
 * button and a clock for "5 min ago".
 */

export function Block({ title, state, children }: { title: string; state?: ReactNode; children: ReactNode })
{
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-content/3 px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-content">{title}</h3>
        {state ? <span className="shrink-0 text-[12px] text-content/55">{state}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Toggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
})
{
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        onChange(!on);
        playCue("switch");
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "bg-content/20"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`}
      />
    </button>
  );
}

/** One choice out of a few, in a row, like the footer ring popover's. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
})
{
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-md bg-content/5 p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            disabled={disabled}
            onClick={() => {
              if (!selected) {
                onChange(option.value);
              }
            }}
            className={`flex-1 rounded px-1.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected ? "bg-content/10 font-semibold text-content" : "text-content/60 hover:text-content"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string })
{
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="rounded p-1.5 text-content/45 hover:bg-selection hover:text-content"
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** The time now, moved on every `everyMs`, for "5 min ago" lines. */
export function useNow(everyMs = 30_000): number
{
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
