import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { headBranch } from "./git-head";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("reads the branch of a checkout and of a worktree, and a detached HEAD", () => {
  const cwd = mkdtempSync(join(tmpdir(), "monocode-head-test-"));
  dirs.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "feature/x");
  expect(headBranch(cwd)).toBe("feature/x");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(cwd, "a"), "a");
  git("add", "a");
  git("commit", "-qm", "a");
  const tree = `${cwd}-tree`;
  dirs.push(tree);
  git("worktree", "add", "-q", "-b", "other", tree);
  expect(headBranch(tree)).toBe("other");
  git("checkout", "-q", "--detach");
  expect(headBranch(cwd)).toBe(git("rev-parse", "--short=7", "HEAD"));
  expect(headBranch(join(cwd, "missing"))).toBe("");
});
