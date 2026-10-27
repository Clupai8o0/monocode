import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importDesktop, mapPath, readLooks } from "./desktop-import";
import { readRoster } from "./mobile-monos";
import { HostStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("maps a Mac home path onto this machine's home", () => {
  expect(mapPath("/Users/clupa/Documents/x", "/home/u")).toBe("/home/u/Documents/x");
  expect(mapPath("/Users/clupa", "/home/u")).toBe("/home/u");
  expect(mapPath("/opt/x", "/home/u")).toBe("/opt/x");
});

it("brings the desktop's projects, their looks and its Monos over, once", () => {
  const root = mkdtempSync(join(tmpdir(), "monocode-import-test-"));
  dirs.push(root);
  const home = join(root, "home");
  const app = join(home, "projects", "app");
  mkdirSync(app, { recursive: true });
  const data = join(root, "data");
  mkdirSync(data);
  const exportDir = join(root, "export");
  mkdirSync(join(exportDir, "monos", "m1"), { recursive: true });
  writeFileSync(join(exportDir, "monos", "m1", "SOUL.md"), "Be kind.");
  const mac = "/Users/clupa/projects/app";
  writeFileSync(
    join(exportDir, "localstorage.json"),
    JSON.stringify({
      "monocode.projectRailOrder": JSON.stringify([mac, "/Users/clupa/projects/gone"]),
      "monocode.projectLocations": JSON.stringify({ [mac]: { path: mac } }),
      "monocode:tab-group:labels": JSON.stringify({ [mac]: "App" }),
      "monocode:tab-group:custom-colors": JSON.stringify({ [mac]: "#123456" }),
      "monocode:tab-group:mascots": JSON.stringify({ [mac]: "bird" }),
      "monocode.defaultModels": JSON.stringify({ claude: "claude:opus" }),
      "monocode:mono-roster": JSON.stringify([
        { id: "m1", name: "Stylist", mascot: "beret", color: "#f0f", projects: [mac], sessionId: "desk" },
        { id: "../bad", mascot: "x", color: "y", projects: [] },
      ]),
    }),
  );
  const store = new HostStore(join(data, "host.db"));
  try {
    const summary = importDesktop(exportDir, data, store, home);
    expect(summary).toEqual({
      projects: [app],
      missing: [join(home, "projects", "gone")],
      monos: ["m1"],
    });
    expect(store.projects().map((project) => [project.cwd, project.name])).toEqual([
      [app, "App"],
    ]);
    expect(readLooks(data)).toEqual({
      order: [app],
      projects: { [app]: { name: "App", color: "#123456", mascot: "bird" } },
      defaultModels: { claude: "claude:opus" },
    });
    // The desktop's session is not this host's: the Mono starts a new one here.
    expect(readRoster(join(data, "monos"))).toEqual([
      { id: "m1", name: "Stylist", mascot: "beret", color: "#f0f", projects: [app] },
    ]);
    expect(readFileSync(join(data, "monos", "m1", "SOUL.md"), "utf8")).toBe("Be kind.");
    expect(importDesktop(exportDir, data, store, home).monos).toEqual([]);
    expect(readRoster(join(data, "monos"))).toHaveLength(1);
  } finally {
    store.close();
  }
});
