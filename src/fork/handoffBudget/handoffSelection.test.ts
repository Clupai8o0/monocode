import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../features/sessions/model/session";
import { budgetedHandoff, HANDOFF_BUDGET_BYTES, trimMiddle } from "./handoffSelection";

function session(blocks: Block[]): Session {
  return { ...newSession("claude", "/repo"), blocks };
}

const user = (id: string, text: string): Block => ({ id, role: "user", text });
const assistant = (id: string, text: string): Block => ({ id, role: "assistant", text });
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("budgetedHandoff", () => {
  it("keeps a short conversation whole, with full message text", () => {
    const brief = budgetedHandoff(
      session([
        user("u1", "Add offline sync to the notes screen."),
        assistant("a1", "Done. Notes now queue writes while offline and replay them on reconnect."),
        user("u2", "Now add a retry button."),
        assistant("a2", "Added the retry button beside the sync status."),
      ]),
    );
    expect(brief).toContain("## Original request (u1)\nAdd offline sync to the notes screen.");
    expect(brief).toContain("### Assistant (a1)\nDone. Notes now queue writes while offline and replay them on reconnect.");
    expect(brief).toContain("### Assistant (a2)");
    expect(brief).not.toContain("## Left out");
  });

  it("leaves out the new request, which is sent on its own", () => {
    const brief = budgetedHandoff(
      session([user("u1", "Build it."), assistant("a1", "Built."), user("u2", "Ship it.")]),
      "Ship it.",
    );
    expect(brief).not.toContain("Ship it.");
    expect(brief).toContain("Built.");
  });

  it("keeps the original request and the newest messages when history is long", () => {
    const blocks: Block[] = [user("u0", "ORIGINAL: migrate the store to SQLite.")];
    for (let i = 1; i <= 40; i++) {
      blocks.push(user(`u${i}`, `Step ${i}: ${"detail ".repeat(100)}`));
      blocks.push(assistant(`a${i}`, `Reply ${i}: ${"result ".repeat(100)}`));
    }
    const brief = budgetedHandoff(session(blocks));
    expect(bytes(brief)).toBeLessThanOrEqual(HANDOFF_BUDGET_BYTES + 200);
    expect(brief).toContain("ORIGINAL: migrate the store to SQLite.");
    expect(brief).toContain("### Assistant (a40)");
    expect(brief).not.toContain("### User (u1)");
    expect(brief).toMatch(/## Left out\n\d+ earlier messages \(u1 to /);
  });

  it("trims one huge message in the middle instead of dropping it", () => {
    const huge = `START ${"x".repeat(50_000)} END`;
    const brief = budgetedHandoff(session([user("u1", "Go."), assistant("a1", huge)]));
    expect(brief).toContain("START");
    expect(brief).toContain("END");
    expect(brief).toContain("middle left out");
    expect(bytes(brief)).toBeLessThan(HANDOFF_BUDGET_BYTES);
  });

  it("lists edits and commands as activity, and skips reads", () => {
    const brief = budgetedHandoff(
      session([
        user("u1", "Fix the test."),
        { id: "t1", role: "tool", text: "Read src/a.ts", tool: { kind: "read" } },
        {
          id: "t2",
          role: "tool",
          text: "Edit",
          tool: { kind: "edit", preview: { kind: "write", path: "/repo/src/a.ts" } },
        },
        { id: "t3", role: "tool", text: "npm test", tool: { kind: "execute", status: "failed" } },
        assistant("a1", "Fixed."),
      ]),
    );
    expect(brief).toContain("- Edit (src/a.ts)");
    expect(brief).toContain("- Ran npm test (failed)");
    expect(brief).not.toContain("Read src/a.ts");
    expect(brief).toContain("## Files edited in this session\n- src/a.ts");
  });

  it("carries a continued thread's handoff, but not one already recapped here", () => {
    const continued = budgetedHandoff(
      session([
        { id: "h", role: "handoff", text: "## Session so far\nUser: build sync\n\n## Conversation archive\nRead /tmp/x.md" },
        user("u1", "keep going"),
      ]),
    );
    expect(continued).toContain("## Previous handoff\n## Session so far\nUser: build sync");
    expect(continued).not.toContain("/tmp/x.md");

    const inThread = budgetedHandoff(
      session([
        user("u1", "build sync"),
        { id: "h", role: "handoff", text: "Recap of u1" },
        user("u2", "more"),
      ]),
    );
    expect(inThread).not.toContain("Recap of u1");
  });

  it("skips drafts, internal blocks and reasoning", () => {
    const brief = budgetedHandoff(
      session([
        user("u1", "Real request"),
        { id: "r", role: "reasoning", text: "SECRET THOUGHTS" },
        { id: "d", role: "user", text: "UNSENT", draft: true },
        { id: "i", role: "assistant", text: "INTERNAL", internal: true },
      ]),
    );
    expect(brief).not.toMatch(/SECRET|UNSENT|INTERNAL/);
  });
});

describe("budgetedHandoff edge cases", () => {
  it("drops an /operator request sent on its own", () => {
    const brief = budgetedHandoff(
      session([user("u1", "Start."), assistant("a1", "Started."), { ...user("u2", "list sessions"), monocode: true }]),
      "/operator list sessions",
    );
    expect(brief).not.toContain("list sessions");
  });

  it("keeps the latest plan even when it falls outside the recent stretch", () => {
    const blocks: Block[] = [user("u0", "Go"), { id: "p1", role: "plan", text: "PLAN: three steps" }];
    for (let i = 1; i <= 40; i++) blocks.push(assistant(`a${i}`, "word ".repeat(300)));
    const brief = budgetedHandoff(session(blocks));
    expect(brief).toContain("## Latest plan (p1)\nPLAN: three steps");
  });
});

describe("trimMiddle", () => {
  it("fits mixed-width text exactly and never splits a character", () => {
    const text = `${"漢".repeat(3_000)}${"a".repeat(3_000)}😀${"b".repeat(10)}`;
    const trimmed = trimMiddle(text, 6_000);
    expect(bytes(trimmed)).toBeLessThanOrEqual(6_000);
    expect(trimmed).not.toContain("\uFFFD");
  });

  it("returns short text unchanged and fits long text to the cap", () => {
    expect(trimMiddle("short", 100)).toBe("short");
    const trimmed = trimMiddle("é".repeat(5_000), 1_000);
    expect(bytes(trimmed)).toBeLessThanOrEqual(1_000);
  });
});
