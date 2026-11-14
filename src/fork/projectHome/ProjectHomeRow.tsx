/**
 * Fork feature: Project home. The row at the top of the inset sidebar's
 * sessions card that opens the project's home, with where the roadmap is.
 */
import { useMemo } from "react";
import { sameProjectPath } from "../../features/projects/model/recents";
import { Home } from "../../shared/ui/icons";
import { useHomePage, usePlans } from "./homeStore";
import { currentPhase, doneCount } from "./planModel";

export function ProjectHomeRow({
  cwd,
  onOpen,
}: {
  cwd: string;
  onOpen: () => void;
}) {
  const page = useHomePage();
  const plans = usePlans(useMemo(() => [cwd], [cwd]));
  const phases = plans.get(cwd)?.plan?.phases;
  const active = page?.kind === "home" && sameProjectPath(page.cwd, cwd);
  const now = phases ? currentPhase(phases) : null;
  const hint = phases?.length
    ? now
      ? `Phase ${now.id}`
      : "Done"
    : "";
  const title = phases?.length
    ? `${doneCount(phases)} of ${phases.length} phases done${now ? `. Now: Phase ${now.id} · ${now.name}` : ""}`
    : "This project's roadmap, chats and what needs you";
  return (
    <div className="shrink-0 px-1.5 pb-1">
      <button
        type="button"
        data-fork-project-home-row=""
        aria-current={active ? "page" : undefined}
        title={title}
        onClick={onOpen}
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none ${
          active
            ? "bg-selection text-content"
            : "text-content/70 hover:bg-content/10 hover:text-content"
        }`}
      >
        <Home className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">Project home</span>
        {hint ? (
          <span className="shrink-0 font-mono text-[11px] text-content/40">{hint}</span>
        ) : null}
      </button>
    </div>
  );
}
