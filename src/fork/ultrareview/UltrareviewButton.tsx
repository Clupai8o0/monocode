import { useRef, useState } from "react";
import { GitPullRequest } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { textControlClass } from "../../features/sessions/ui/ModelPicker";
import { requestUltrareview, ultrareviewCommand } from "./ultrareview";

/**
 * Fork: composer button for Claude Code's ultrareview. The popover takes an
 * optional PR number or base branch and runs `claude ultrareview` in a
 * terminal in the current project; the CLI asks before billing.
 */
export const FORK_ULTRAREVIEW = import.meta.env.MODE !== "test";

export function UltrareviewButton() {
  return FORK_ULTRAREVIEW ? <Ultrareview /> : null;
}

function Ultrareview() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-ultrareview=""
        className={textControlClass(open, "shrink-0 gap-1.5 whitespace-nowrap")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Ultrareview"
        title="Ultrareview: cloud code review of this branch or a PR"
        onClick={() => setOpen(!open)}
      >
        <GitPullRequest
          className="size-3.5 shrink-0"
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="hidden @min-[420px]/composer-toolbar:inline">Ultrareview</span>
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          gap={6}
          width={300}
          ignore="[data-fork-ultrareview]"
          autoFocus
          aria-label="Ultrareview"
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") anchor.current?.focus();
          }}
        >
          <UltrareviewPanel onDone={() => setOpen(false)} />
        </Popover>
      ) : null}
    </>
  );
}

function UltrareviewPanel({ onDone }: { onDone: () => void }) {
  const [target, setTarget] = useState("");
  const valid = ultrareviewCommand(target) !== null;
  return (
    <form
      className="flex flex-col gap-2 p-3 text-[12px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (requestUltrareview(target)) onDone();
      }}
    >
      <span className="text-[13px] font-semibold text-content">
        Ultrareview
      </span>
      <span className="text-content/55">
        Runs in a terminal in this project. Billed; the CLI asks first.
      </span>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={target}
          maxLength={120}
          placeholder="This branch, or PR # / base branch"
          aria-label="PR number or base branch"
          aria-invalid={!valid}
          onChange={(event) => setTarget(event.target.value)}
          className="min-w-0 flex-1 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-content outline-none placeholder:text-content/35 focus:border-accent"
        />
        <button
          type="submit"
          disabled={!valid}
          className="rounded px-1.5 py-0.5 font-medium text-content/80 bg-content/6 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          Run
        </button>
      </div>
      {!valid ? (
        <span className="text-amber-500">
          Use a PR number or a branch name.
        </span>
      ) : null}
    </form>
  );
}
