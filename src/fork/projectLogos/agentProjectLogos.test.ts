// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentApp, type AgentAppHost } from "../../features/agent-app/model/agentApp";
import { newSession } from "../../features/sessions/model/session";
import { loadTabGroupLogos, saveTabGroupLogo, loadTabGroupLogoBackgrounds } from "../../features/workspace/model/tabGroups";
import { agentProjectLogo } from "./agentProjectLogos";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:tab-group:key-version", "2");
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

describe("project logo app actions", () => {
  const cwd = "/projects/panoptic";
  const source = newSession("codex", cwd);
  const host = { isMono: () => false } as AgentAppHost;

  it("sets a project-local asset using existing saved-logo storage", async () => {
    mocks.invoke.mockResolvedValue("/app/logos/panoptic.png");
    const result = await handleAgentApp(source, "logo-1", "projects.logo.set", {
      path: "frontend/public/logo.png", background: "light",
    }, host);
    expect(mocks.invoke).toHaveBeenCalledWith("save_project_logo", {
      project: cwd, projectRoot: cwd, sourcePath: "frontend/public/logo.png",
    });
    expect(result).toEqual({ project: cwd, logo: "/app/logos/panoptic.png", background: "light" });
    expect(loadTabGroupLogos()[cwd]).toBe("/app/logos/panoptic.png");
  });

  it("reads and clears the same logo the manual picker sees", async () => {
    saveTabGroupLogo(cwd, "/app/logos/panoptic.png");
    expect(await handleAgentApp(source, "read-1", "projects.logo", {}, host)).toEqual({
      project: cwd, logo: "/app/logos/panoptic.png", background: "transparent",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    await handleAgentApp(source, "clear-1", "projects.logo.clear", {}, host);
    expect(mocks.invoke).toHaveBeenCalledWith("remove_project_logo", { project: cwd });
    expect(loadTabGroupLogos()[cwd]).toBeUndefined();
    expect(loadTabGroupLogoBackgrounds()[cwd]).toBeUndefined();
  });

  it("keeps the previous logo when the backend rejects an invalid image or path", async () => {
    saveTabGroupLogo(cwd, "/app/logos/previous.svg");
    mocks.invoke.mockRejectedValue(new Error("Project logo must be a file inside this project"));
    await expect(handleAgentApp(source, "bad-1", "projects.logo.set", {
      path: "../secret.png",
    }, host)).rejects.toThrow("inside this project");
    expect(loadTabGroupLogos()[cwd]).toBe("/app/logos/previous.svg");
  });

  it("only lets Monos name one of their authorized projects", async () => {
    await expect(handleAgentApp(source, "bad-1", "projects.logo.set", {
      path: "logo.svg", project: "/projects/other",
    }, host)).rejects.toThrow("project is only for a Mono");
    const monoHost = { ...host, monoOf: () => ({ id: "mono", projects: [cwd] }) };
    await expect(handleAgentApp(source, "bad-2", "projects.logo.set", {
      path: "logo.svg", project: "/projects/other",
    }, monoHost)).rejects.toThrow("Not one of your projects");
    mocks.invoke.mockResolvedValue("/app/logos/panoptic.svg");
    await handleAgentApp(source, "good-1", "projects.logo.set", {
      path: "logo.svg", project: "panoptic",
    }, monoHost);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { path: "" }, { path: "logo.svg", background: "red" }, { path: "logo.svg", arbitrary: true },
  ])("rejects invalid logo inputs before invoking native code: %j", async (input) => {
    await expect(handleAgentApp(source, "bad", "projects.logo.set", input, host)).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects remote logo writes explicitly", async () => {
    const { REMOTE_PATH_PREFIX } = await import("../../shared/lib/remotePaths");
    await expect(agentProjectLogo(`${REMOTE_PATH_PREFIX}remote/project`, "projects.logo.set", "logo.png"))
      .rejects.toThrow("local project");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
