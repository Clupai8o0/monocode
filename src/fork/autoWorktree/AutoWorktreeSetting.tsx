import { saveAutoWorktreePolicy, type AutoWorktreePolicy } from "./autoWorktree";
import { useAutoWorktreePolicy } from "./useAutoWorktree";

const CHOICES: {
  id: AutoWorktreePolicy;
  label: string;
  note: string;
}[] = [
  {
    id: "smart",
    label: "Smart",
    note: "When another session is busy here, or there are uncommitted changes.",
  },
  {
    id: "always",
    label: "Always",
    note: "Every new session starts in its own copy.",
  },
  {
    id: "never",
    label: "Never",
    note: "Sessions share the checkout unless you pick a worktree.",
  },
];

/** Little branch shapes: how sessions sit on the project under each choice. */
function Picture({ id }: { id: AutoWorktreePolicy }) {
  const strand = (y: number) =>
    `M6 34C14 34 16 ${y} 26 ${y}H74`;
  return (
    <svg
      viewBox="0 0 80 40"
      className="h-10 w-full"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 34H74" stroke="currentColor" strokeOpacity={0.25} />
      <circle cx="6" cy="34" r="2.5" fill="currentColor" fillOpacity={0.45} />
      {id === "never" ? (
        <>
          <circle cx="40" cy="34" r="3" className="fill-accent" />
          <circle cx="62" cy="34" r="3" className="fill-accent" />
        </>
      ) : null}
      {id === "smart" ? (
        <>
          <circle cx="40" cy="34" r="3" className="fill-accent" />
          <path d={strand(10)} className="stroke-accent" />
          <circle cx="62" cy="10" r="3" className="fill-accent" />
        </>
      ) : null}
      {id === "always" ? (
        <>
          <path d={strand(6)} className="stroke-accent" />
          <circle cx="62" cy="6" r="3" className="fill-accent" />
          <path d={strand(20)} className="stroke-accent" strokeOpacity={0.6} />
          <circle cx="50" cy="20" r="3" className="fill-accent" fillOpacity={0.6} />
        </>
      ) : null}
    </svg>
  );
}

/** Fork: Settings → Worktrees, when a new session gets its own worktree. */
export function AutoWorktreeSetting() {
  const policy = useAutoWorktreePolicy();
  return (
    <section
      data-setting-id="auto-worktree"
      id="setting-auto-worktree"
      className="mb-6 font-sans"
    >
      <h3 className="text-[13px] font-medium text-content">
        New sessions get their own worktree
      </h3>
      <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-content/50">
        A worktree is a separate copy of the project on its own branch, so
        sessions running side by side can't overwrite each other.
      </p>
      <div
        role="radiogroup"
        aria-label="New sessions get their own worktree"
        className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-3"
      >
        {CHOICES.map((choice) => {
          const selected = policy === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => saveAutoWorktreePolicy(choice.id)}
              className={`flex flex-col gap-2 rounded-xl px-3 py-2.5 text-left transition-[background-color,transform] duration-150 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                selected ? "bg-accent/12" : "bg-content/[0.04] hover:bg-content/[0.07]"
              }`}
            >
              <span className={selected ? "text-content/70" : "text-content/40"}>
                <Picture id={choice.id} />
              </span>
              <span>
                <span
                  className={`block text-[13px] font-medium ${
                    selected ? "text-content" : "text-content/75"
                  }`}
                >
                  {choice.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-content/50">
                  {choice.note}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
