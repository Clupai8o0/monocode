import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { answered, monoContext, monoName, monoTurn, readRoster } from "./mobile-monos";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mono = {
  id: "m1",
  mascot: "invader",
  color: "#f00",
  projects: ["/home/u/app", "/home/u/site"],
};

it("names an unnamed Mono after its mascot", () => {
  expect(monoName(mono)).toBe("MonoInvader");
  expect(monoName({ ...mono, name: " Stylist " })).toBe("Stylist");
});

it("keeps only well-formed Monos from the roster", () => {
  const dir = mkdtempSync(join(tmpdir(), "monocode-monos-test-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "roster.json"),
    JSON.stringify([
      mono,
      { id: "../escape", mascot: "x", color: "y", projects: [] },
      { id: "m2" },
      { ...mono, id: "m3", name: 42 },
    ]),
  );
  expect(readRoster(dir).map((entry) => entry.id)).toEqual(["m1"]);
  expect(readRoster(join(dir, "missing"))).toEqual([]);
});

it("hands over who the Mono is, its soul and its memory, only as planned", () => {
  const files = { soul: "Be terse.", memory: "- 2026-10-28: likes tea" };
  const full = monoContext(mono, "/data/monos/m1", files, { soul: true, memory: true });
  expect(full).toContain("You are MonoInvader");
  expect(full).toContain("- app: /home/u/app");
  expect(full).toContain("Be terse.");
  expect(full).toContain("/data/monos/m1/MEMORY.md");
  expect(full).toContain("likes tea");
  const memoryOnly = monoContext(mono, "/d", files, { soul: false, memory: true });
  expect(memoryOnly).not.toContain("Be terse.");
  expect(memoryOnly).toContain("likes tea");
  expect(monoContext(mono, "/d", files, { soul: false, memory: false })).toBe("");
  expect(monoTurn("hi", "")).toBe("hi");
  expect(monoTurn("hi", "<x/>")).toMatch(/^<monocode_context>[\s\S]*<x\/>[\s\S]*\n\nhi$/);
});

it("counts a turn as handed over only once the agent answered it", () => {
  const value = (blocks: { id: string; role: string; text?: string }[]) =>
    ({ session: { blocks } }) as never;
  expect(answered(value([{ id: "u1", role: "user" }]), "u1")).toBe(false);
  expect(
    answered(value([{ id: "u1", role: "user" }, { id: "a", role: "assistant", text: "Hi" }]), "u1"),
  ).toBe(true);
  expect(
    answered(
      value([
        { id: "u1", role: "user" },
        { id: "u2", role: "user" },
        { id: "a", role: "assistant", text: "Hi" },
      ]),
      "u1",
    ),
  ).toBe(false);
  expect(answered(value([]), "gone")).toBe(false);
});
