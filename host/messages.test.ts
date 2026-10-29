import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageReader, keyOf, previewOf, scrub } from "./messages";

const FIXTURE = join(__dirname, "..", "tests", "fixtures", "message-log");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh copy of the fixture. home/.claude is not in the repository (the
 *  checkout ignores .claude/), so the fixture script writes it here. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-messages-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURE, "make_fixture.py"), join(dir, "make_fixture.py"));
  execFileSync("python3", [join(dir, "make_fixture.py")], { stdio: "ignore" });
  const committed = readFileSync(join(FIXTURE, "expected.json"), "utf8");
  expect(readFileSync(join(dir, "expected.json"), "utf8")).toBe(committed);
  return dir;
}

function touchAll(root: string, when: number) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) touchAll(path, when);
    else if (name.name.endsWith(".jsonl")) utimesSync(path, when / 1000, when / 1000);
  }
}

const live = (pid: number) => pid < 1_000_000_000;

describe("message log reader", () => {
  it("gives every answer in expected.json", async () => {
    const dir = fixture();
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    const home = join(dir, "home");
    const reader = createMessageReader();
    let previous: { epoch: string; cursor: number } | undefined;
    for (const step of expected.steps) {
      for (const append of step.append ?? []) {
        appendFileSync(join(dir, append.to), readFileSync(join(dir, append.from)));
      }
      const now = Date.parse(step.now);
      touchAll(home, now);
      const params = { ...step.params };
      if (params.since === "previous") params.since = previous;
      const answer = await reader.scan(params, { home, machine: expected.machine, now, isLive: live });
      const { epoch, ...rest } = answer;
      expect(typeof epoch, step.name).toBe("string");
      expect(rest, step.name).toEqual({
        version: 1,
        machine: expected.machine,
        scannedAt: now,
        sessions: expected.sessions,
        proxies: expected.proxies,
        ...step.expect,
      });
      const text = JSON.stringify(answer);
      for (const word of expected.forbidden) expect(text, `${step.name}: ${word}`).not.toContain(word);
      expect(text).not.toContain("null");
      previous = { epoch, cursor: answer.cursor };
    }
  });

  it("reads a big file from its tail and a replaced file again", async () => {
    const dir = fixture();
    const home = join(dir, "home");
    const path = join(home, ".claude/projects/-p-alpha/11111111-1111-4111-8111-111111111111.jsonl");
    const now = Date.parse("2026-10-29T09:00:00.000Z");
    touchAll(home, now);
    const reader = createMessageReader();
    const options = { home, machine: "m", now, isLive: () => true, tailMaxBytes: 8_000 };
    const first = await reader.scan({}, options);
    const alpha = first.events.filter((event) => event.sessionId.startsWith("1111"));
    // Only the last 8000 bytes were read: the earliest sends are not there.
    expect(alpha.some((event) => event.id.endsWith(":toolu_A1"))).toBe(false);
    expect(alpha.length).toBeGreaterThan(0);

    const text = readFileSync(path, "utf8").split("\n").slice(0, 3).join("\n") + "\n";
    rmSync(path);
    writeFileSync(path, text);
    utimesSync(path, now / 1000, now / 1000);
    const second = await reader.scan({ since: { epoch: first.epoch, cursor: first.cursor } }, options);
    expect(second.full).toBe(false);
    expect(second.events.map((event) => event.id)).toEqual([
      "11111111-1111-4111-8111-111111111111:toolu_A1",
    ]);
    expect(second.events[0].rev).toBe(2);
  });

  it("reads a linked account folder once and skips old files", async () => {
    const dir = fixture();
    const home = join(dir, "home");
    rmSync(join(home, ".claude-exec"), { recursive: true });
    symlinkSync(join(home, ".claude"), join(home, ".claude-exec"));
    const now = Date.parse("2026-10-29T09:00:00.000Z");
    touchAll(home, now);
    const reader = createMessageReader();
    const answer = await reader.scan({}, { home, machine: "m", now, isLive: () => true });
    expect(answer.sessions.map((session) => session.account)).toEqual(["main"]);
    expect(new Set(answer.events.map((event) => event.account))).toEqual(new Set(["main"]));

    const old = mkdtempSync(join(tmpdir(), "monocode-messages-old-"));
    dirs.push(old);
    mkdirSync(join(old, ".claude/projects/-x"), { recursive: true });
    const file = join(old, ".claude/projects/-x/abcdefgh-1.jsonl");
    copyFileSync(join(home, ".claude/projects/-p-alpha/11111111-1111-4111-8111-111111111111.jsonl"), file);
    utimesSync(file, (now - 30 * 3_600_000) / 1000, (now - 30 * 3_600_000) / 1000);
    const none = await createMessageReader().scan({}, { home: old, machine: "m", now, isLive: () => true });
    expect(none.events).toEqual([]);
    expect(statSync(file).size).toBeGreaterThan(0);
  });

  it("clamps the window", async () => {
    const home = mkdtempSync(join(tmpdir(), "monocode-messages-empty-"));
    dirs.push(home);
    const reader = createMessageReader();
    const options = { home, machine: "m", now: 1, isLive: () => true };
    expect((await reader.scan({ windowHours: 1000 }, options)).windowHours).toBe(168);
    expect((await reader.scan({ windowHours: 0 }, options)).windowHours).toBe(1);
    expect((await reader.scan({}, options)).windowHours).toBe(24);
  });

  it("follows the text rules", () => {
    expect(scrub("at uds:/tmp/cc-socks/1.sock: lstat '/tmp/x.sock'")).toBe("at uds:…: lstat '…'");
    expect(keyOf("  a b \n\t c  ")).toBe("a b c");
    expect(previewOf("🙂".repeat(700))).toBe("🙂".repeat(600));
  });
});
