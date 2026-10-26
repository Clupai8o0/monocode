import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import { useProjectAppearance } from "../hooks/useProjectAppearance";
import { basename } from "../../../platform/tauri/fs";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
// Fork: a saved brand alternates with the working mascot while running.
import { ProjectIdentityIcon } from "../../../fork/projectLogos/ProjectIdentityIcon";
import { ProjectMascot } from "./ProjectMascot";

/** The project's name as the rail and pickers show it, renames included. */
export function useProjectLabel(cwd: string): string {
  const { groupLabels } = useProjectAppearance();
  return resolveTabGroupLabel(
    projectKey(cwd),
    groupLabels,
    basename(cwd) || projectName(cwd),
  );
}

/** The project's saved logo, or its mascot when it has none. */
export function CurrentProjectIcon({
  cwd,
  busy = false,
  className = "size-5",
  mascotClassName = "size-3.5",
}: {
  cwd: string;
  busy?: boolean;
  className?: string;
  mascotClassName?: string;
}) {
  const { groupColors, groupCustomColors, groupMascots } =
    useProjectAppearance();
  const groupLogos = useTabGroupLogos();
  const key = projectKey(cwd);
  const seed = projectName(cwd);
  const logoPath = resolveTabGroupLogo(key, groupLogos);
  if (logoPath)
    return (
      <ProjectIdentityIcon
        logoPath={logoPath}
        project={seed}
        color={resolveTabGroupColor(key, groupColors, groupCustomColors, seed)}
        mascot={resolveTabGroupMascot(key, groupMascots)}
        busy={busy}
        className={className}
        mascotClassName={mascotClassName}
      />
    );
  return (
    <span
      className={`${className} grid shrink-0 place-items-center rounded-[5px] bg-content/8`}
    >
      <ProjectMascot
        project={seed}
        color={resolveTabGroupColor(key, groupColors, groupCustomColors, seed)}
        name={resolveTabGroupMascot(key, groupMascots)}
        className={mascotClassName}
        active={busy}
      />
    </span>
  );
}
