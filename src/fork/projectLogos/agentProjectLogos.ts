import { projectKey } from "../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import {
  loadTabGroupLogos,
  loadTabGroupLogoBackgrounds,
  type ProjectLogoBackground,
} from "../../features/workspace/model/tabGroups";
import {
  clearProjectLogo,
  setProjectLogo,
} from "../../features/projects/model/projectLogos";

export async function agentProjectLogo(
  cwd: string,
  action: string,
  path?: string,
  background?: ProjectLogoBackground,
  iconsDir?: string | null,
): Promise<{ project: string; logo: string | null; background: string }> {
  const key = projectKey(cwd);
  if (action === "projects.logo.set") {
    if (cwd.startsWith(REMOTE_PATH_PREFIX)) {
      throw new Error("Agent logo changes currently require a local project.");
    }
    if (!path) {
      throw new Error("path is required to set a project logo");
    }
    // Fork (src/fork/stylist): a Mono may apply an icon it made in its own
    // icons folder; native code still checks the file stays inside that root.
    const root = iconsDir && path.startsWith(`${iconsDir}/`) ? iconsDir : cwd;
    await setProjectLogo(cwd, path, { projectRoot: root, background });
  } else if (action === "projects.logo.clear") {
    await clearProjectLogo(key);
  }
  return {
    project: cwd,
    logo: loadTabGroupLogos()[key] ?? null,
    background: loadTabGroupLogoBackgrounds()[key] ?? "transparent",
  };
}
