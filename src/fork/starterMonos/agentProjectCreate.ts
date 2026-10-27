import { createPath } from "../../platform/tauri/fs";
import { addMonoProject, findMono, monoWorksOn } from "../../features/monos/model/mono";
import { withMonoConfigurationLock } from "../../features/monos/model/monoConfigurationLock";
import { notifyProjectPathsChanged, rememberProject } from "../../features/projects/model/recents";
import { projectName } from "../../shared/lib/paths";

/**
 * Fork: `projects.create`, so a Mono (the Kickoff in particular) can start a
 * project: a new, empty folder that joins MonoCode's projects and the Mono's
 * own. It never adopts a folder that already exists.
 */
export const DEFAULT_PROJECTS_PARENT = "~/Documents/projects";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parentFolder(value: unknown): string {
  if (value === undefined) return DEFAULT_PROJECTS_PARENT;
  if (typeof value !== "string" || value.length > 1024 || !(value.startsWith("/") || value.startsWith("~/"))) {
    throw new Error("parent must be an absolute or ~/ folder path");
  }
  if (value.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new Error("parent cannot contain . or .. segments");
  }
  return value.replace(/\/+$/, "") || "/";
}

export async function createAgentProject(
  monoId: string,
  input: Record<string, unknown>,
  addProject?: (path: string) => void,
): Promise<{ project: string; name: string; note: string }> {
  const name = input.name;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error("name must be a folder name: letters, digits, '.', '_' or '-', starting with a letter or digit, up to 64 characters");
  }
  const parent = parentFolder(input.parent);
  // One window at a time, so two calls never both take one folder name or
  // write over each other's rail and roster.
  return withMonoConfigurationLock(() => createUnderLock(monoId, name, parent, addProject));
}

async function createUnderLock(
  monoId: string,
  name: string,
  parent: string,
  addProject?: (path: string) => void,
): Promise<{ project: string; name: string; note: string }> {
  if (!findMono(monoId)) throw new Error("Your Mono is no longer on the roster");
  // Fails when the folder already exists, so no existing work is taken over.
  const project = await createPath(parent, name, true);
  if (addProject) {
    addProject(project);
  } else {
    rememberProject(project);
    notifyProjectPathsChanged();
  }
  const mono = findMono(monoId);
  if (mono && !monoWorksOn(mono, project)) addMonoProject(monoId, project);
  return {
    project,
    name: projectName(project),
    note: "Created empty and added to MonoCode and to your projects. Write files with absolute paths; pass this path as project to other actions.",
  };
}
