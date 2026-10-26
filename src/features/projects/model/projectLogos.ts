import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { projectKey } from "../../../shared/lib/paths";
import {
  loadTabGroupLogos,
  loadTabGroupLogoBackgrounds,
  notifyTabGroupLogosChanged,
  saveTabGroupLogo,
  saveTabGroupLogoBackground,
  tabGroupLogoDisplayRevision,
  type ProjectLogoBackground,
} from "../../workspace/model/tabGroups";

export async function pickImageFile(directory: string): Promise<string | null> {
  const selected = await open({
    defaultPath: directory,
    multiple: false,
    directory: false,
    title: "Choose project logo",
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
      },
    ],
  });
  if (typeof selected === "string" && selected) return selected;
  return null;
}

/**
 * The file a project is about to stop showing, or `null` when it must stay.
 *
 * Logos are filed on disk under a stem derived from the project key, so a logo
 * saved before the keys became paths sits under a stem nothing derives anymore
 * and the stored path is the only handle left to it. Migrated projects that
 * shared a folder name also share that one file, so it only goes when the last
 * project pointing at it lets go.
 */
export function droppableLogoFile(
  logos: Record<string, string>,
  project: string,
  keep?: string,
): string | null {
  const previous = logos[project];
  if (!previous || previous === keep) return null;
  const shared = Object.entries(logos).some(
    ([key, path]) => key !== project && path === previous,
  );
  return shared ? null : previous;
}

async function forgetLogoFile(path: string | null): Promise<void> {
  if (!path) return;
  await invoke("forget_logo_file", { path }).catch(() => undefined);
}

export async function pickAndSetProjectLogo(projectPath: string): Promise<string | null> {
  const sourcePath = await pickImageFile(projectPath);
  if (!sourcePath) return null;
  return setProjectLogo(projectPath, sourcePath);
}

/** The picker and agent app actions use the same saved appearance. */
export async function setProjectLogo(
  projectPath: string,
  sourcePath: string,
  options: { projectRoot?: string; background?: ProjectLogoBackground } = {},
): Promise<string> {
  const project = projectKey(projectPath);
  const logos = loadTabGroupLogos();
  const path = await invoke<string>("save_project_logo", {
    project,
    sourcePath,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  await forgetLogoFile(droppableLogoFile(logos, project, path));
  saveTabGroupLogo(project, path);
  if (options.background !== undefined) {
    saveTabGroupLogoBackground(project, options.background);
  }
  notifyTabGroupLogosChanged();
  return path;
}

export async function clearProjectLogo(project: string): Promise<void> {
  const stale = droppableLogoFile(loadTabGroupLogos(), project);
  await invoke("remove_project_logo", { project });
  await forgetLogoFile(stale);
  saveTabGroupLogo(project, null);
  saveTabGroupLogoBackground(project, "transparent");
  notifyTabGroupLogosChanged();
}

export function projectLogoSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${convertFileSrc(path)}?v=${tabGroupLogoDisplayRevision()}`;
}

/** Copied logo paths are per-project; old shared logos use the first explicit backdrop. */
export function projectLogoBackground(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const backgrounds = loadTabGroupLogoBackgrounds();
  for (const [key, logo] of Object.entries(loadTabGroupLogos())) {
    if (logo !== path) continue;
    if (backgrounds[key] === "light") return "#ffffff";
    if (backgrounds[key] === "dark") return "#181818";
  }
  return undefined;
}
