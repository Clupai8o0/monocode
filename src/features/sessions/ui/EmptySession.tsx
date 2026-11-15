import { type ReactNode, useSyncExternalStore } from "react";
import { basename } from "../../../platform/tauri/fs";
import { projectKey } from "../../../shared/lib/paths";
import { looksLikeProject } from "../../projects/model/recents";
import {
  loadTabGroupLabels,
  resolveTabGroupLabel,
  subscribeTabGroupLabels,
} from "../../workspace/model/tabGroups";
import {
  loadGridArcadeEnabled,
  subscribeGridArcadeEnabled,
} from "../../settings/model/settings";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { lazySurface } from "../../../shared/ui/lazySurface";
// Fork: a project's empty chat opens on that project's home.
import { useHomeInlineData } from "../../../fork/projectHome/homeInline";
import { ProjectHomeInline } from "../../../fork/projectHome/ProjectHomePage";
// Fork: idle games load only when an empty session shows them.
const TerminalGridBackground = lazySurface(() =>
  import("../../terminal/ui/TerminalGridBackground")
    .then((module) => ({ default: module.TerminalGridBackground }))
    // Only a backdrop here: a session works without it, so a failed load can't
    // be allowed to take the window down.
    .catch(() => ({ default: () => null })),
);

type Props = {
  cwd: string;
  composer?: ReactNode;
  hasChatBackground?: boolean;
};

export function EmptySession({ cwd, composer, hasChatBackground }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const arcadeEnabled = useSyncExternalStore(
    subscribeGridArcadeEnabled,
    loadGridArcadeEnabled,
    () => true,
  );
  const getProjectLabel = () =>
    looksLikeProject(cwd)
      ? resolveTabGroupLabel(
          projectKey(cwd),
          loadTabGroupLabels(),
          basename(cwd),
        )
      : null;
  const project = useSyncExternalStore(
    subscribeTabGroupLabels,
    getProjectLabel,
    getProjectLabel,
  );
  const title = project
    ? `What should we work on in ${project}?`
    : "What should we work on?";
  const homeData = useHomeInlineData(); // Fork

  // Only local folders: the home's roadmap, chats and launches are local.
  if (homeData && project !== null && cwd.startsWith("/")) {
    // The home scrolls; the composer stays under it in the docked composer's
    // box (max-w-4xl, p-1.5), so its pickers open upward over the home and
    // the first message docks it without a jump.
    return (
      <div data-session-home className="@container relative flex h-full min-h-0 flex-col">
        <div
          ref={lockOverscroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-none"
        >
          <ProjectHomeInline cwd={cwd} data={homeData} />
        </div>
        {composer ? (
          <div className="relative z-10 mx-auto w-full max-w-4xl shrink-0 px-1.5 pb-1.5">
            {composer}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={lockOverscroll}
      className="@container relative flex h-full min-h-0 overflow-y-auto overscroll-none"
    >
      {/* Fork: keep the composer in place while the background loads. */}
      {arcadeEnabled && !hasChatBackground ? (
        <TerminalGridBackground />
      ) : null}
      {composer ? (
        // Same box as the docked composer (max-w-4xl, p-1.5), so the input
        // keeps its width when the first message docks it. The spacers center
        // it when there's room. Once the pane is narrower than the composer
        // (or too short), the bottom spacer gives way so the input sits where
        // it will dock, and the title drops so it reads as the docked composer.
        // `overflow-clip` keeps the composer's blur bleed (`::before`) from
        // counting as scrollable overflow once the input is flush with the
        // pane edges, which let the pane scroll a few pixels both ways.
        <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-clip px-1.5 pt-6 pb-1.5">
          <div aria-hidden className="flex-[1_1_0px]" />
          <div className="pointer-events-auto mb-4 shrink-0 px-2.5 @max-4xl:hidden">
            <h1
              className="truncate text-lg text-content"
              title={project ? cwd : undefined}
            >
              {title}
            </h1>
          </div>

          <div className="pointer-events-auto w-full shrink-0">{composer}</div>
          <div aria-hidden className="flex-[1_1_1.125rem] @max-4xl:hidden" />
        </div>
      ) : null}
    </div>
  );
}
