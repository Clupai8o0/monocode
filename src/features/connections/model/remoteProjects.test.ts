// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  remotePath,
  remoteProjectFor,
  remoteSessionGitCwd,
  unaddedHostProjects,
} from "./remoteProjects";

it("offers only host projects not yet added on this machine", () => {
  const added = [
    { key: "remote://env/srv/a", environmentId: "env", projectId: "a", cwd: "/srv/a" },
    { key: "remote://env/srv/b", environmentId: "env", projectId: "old-b", cwd: "/srv/b/" },
  ];
  expect(
    unaddedHostProjects(
      "env",
      [
        { id: "a", cwd: "/srv/a-moved", name: "a" },
        { id: "b", cwd: "/srv/b", name: "b" },
        { id: "c", cwd: "/srv/c", name: "c" },
      ],
      added,
    ).map((project) => project.id),
  ).toEqual(["c"]);
});

it("finds a saved UNC project through its corrected remote path", () => {
  const legacyKey = "remote://env/server/share/repo";
  const project = {
    key: legacyKey,
    environmentId: "env",
    projectId: "project",
    cwd: "\\\\server\\share\\repo",
  };
  localStorage.setItem("monocode.remote-projects.v2", JSON.stringify({ [legacyKey]: project }));
  expect(remoteProjectFor(remotePath("env", project.cwd))).toEqual(project);
  localStorage.removeItem("monocode.remote-projects.v2");
});

const gitProject = { environmentId: "env", cwd: "/home/dev/repo" };

it("diffs a linked worktree in the worktree, not the project root", () => {
  expect(
    remoteSessionGitCwd(gitProject, "/home/dev/repo/.monocode/worktrees/fix", "/home/dev/repo"),
  ).toBe(remotePath("env", "/home/dev/repo/.monocode/worktrees/fix"));
});

it("keeps the project root when the session has no separate work path", () => {
  expect(remoteSessionGitCwd(gitProject, "/home/dev/repo", "/home/dev/repo")).toBe(
    remotePath("env", "/home/dev/repo"),
  );
  expect(remoteSessionGitCwd(gitProject, undefined, "/home/dev/repo")).toBe(
    remotePath("env", "/home/dev/repo"),
  );
});

it("passes an already-remote session work path through untouched", () => {
  const wrapped = remotePath("env", "/home/dev/repo/.monocode/worktrees/fix");
  expect(remoteSessionGitCwd(gitProject, wrapped, "/home/dev/repo")).toBe(wrapped);
});

it("diffs the worktree a remote tab picked before its session starts", () => {
  // A pending worktree pick is stored as a host path while the git cwd still
  // sits on the `remote://` project root; the sidebar's Changes panel lists
  // the pick, so the diff must run in it too.
  const root = remotePath("env", "/home/dev/repo");
  expect(
    remoteSessionGitCwd(
      gitProject,
      root,
      root,
      "/home/dev/repo/.monocode/worktrees/fix",
    ),
  ).toBe(remotePath("env", "/home/dev/repo/.monocode/worktrees/fix"));
});

it("keeps the tab's session checkout ahead of a stray remote git cwd", () => {
  expect(
    remoteSessionGitCwd(
      gitProject,
      remotePath("env", "/home/dev/other"),
      remotePath("env", "/home/dev/repo"),
      "/home/dev/repo",
    ),
  ).toBe(remotePath("env", "/home/dev/repo"));
});

it("passes an already-remote tab checkout through untouched", () => {
  const wrapped = remotePath("env", "/home/dev/repo/.monocode/worktrees/fix");
  expect(
    remoteSessionGitCwd(
      gitProject,
      remotePath("env", "/home/dev/repo"),
      remotePath("env", "/home/dev/repo"),
      wrapped,
    ),
  ).toBe(wrapped);
});
