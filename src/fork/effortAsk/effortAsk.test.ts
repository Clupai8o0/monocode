import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../features/sessions/model/models";
import type { Block, Session } from "../../features/sessions/model/session";
import {
  effortNeededOfBlocks,
  effortAutoFor,
  effortChangeFor,
  effortChangesOfEndedTurns,
  parseEffortNeeded,
  sessionsGoneIdle,
  withEffortChange,
} from "./effortAsk";

const LINE = "Effort: high now, xhigh needed (hard debugging).";

function block(role: Block["role"], text: string, extra?: Partial<Block>): Block {
  return { id: crypto.randomUUID(), role, text, ...extra };
}

function session(blocks: Block[], extra?: Partial<Session>): Session {
  return {
    id: "s1",
    harness: "claude",
    model: "claude:opus-5-5",
    modelSettings: { effort: "high" },
    blocks,
    ...extra,
  } as Session;
}

// Claude's effort options come from its live catalog, listed high to low.
beforeAll(() => {
  setHarnessModels("claude", [
    {
      id: "claude:opus-5-5",
      harness: "claude",
      name: "Claude Opus 5.5",
      nativeId: "claude-opus-5-5",
      settings: [
        {
          id: "effort",
          label: "Reasoning",
          kind: "select",
          value: "high",
          options: [
            { value: "max", label: "Max" },
            { value: "xhigh", label: "Extra High" },
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
        },
      ],
    },
  ]);
});

afterAll(() => {
  resetHarnessModelOverlays();
});

describe("parseEffortNeeded", () => {
  it("reads the needed level from the first non-empty line", () => {
    expect(parseEffortNeeded(`\n\n${LINE}\nMore text`)).toBe("xhigh");
  });

  it("ignores markdown around the line", () => {
    expect(parseEffortNeeded("**Effort: `low` now, _High_ needed (x)**")).toBe(
      "high",
    );
  });

  it("only looks at the first line", () => {
    expect(parseEffortNeeded(`Some answer\n${LINE}`)).toBeNull();
  });

  it("rejects lines that only look alike", () => {
    expect(parseEffortNeeded("Effort: high")).toBeNull();
    expect(parseEffortNeeded("The effort: high now, xhigh needed")).toBeNull();
    expect(parseEffortNeeded("")).toBeNull();
  });
});

describe("effortNeededOfBlocks", () => {
  it("finds the line on an earlier block when tools followed it", () => {
    expect(
      effortNeededOfBlocks([
        block("assistant", LINE),
        block("tool", "Effort: low now, max needed (not a reply)"),
        block("assistant", "All done."),
      ]),
    ).toBe("xhigh");
  });

  it("prefers the latest line in the turn", () => {
    expect(
      effortNeededOfBlocks([
        block("assistant", LINE),
        block("assistant", "Effort: high now, max needed (worse than it looked)"),
      ]),
    ).toBe("max");
  });
});

describe("effortChangeFor", () => {
  const ask = [block("user", "go"), block("assistant", LINE)];

  it("raises to a higher option of the model", () => {
    expect(effortChangeFor(session(ask))).toMatchObject({
      settingId: "effort",
      value: "xhigh",
      direction: "raised",
    });
  });

  it("lowers to a lower option of the model", () => {
    expect(
      effortChangeFor(session(ask, { modelSettings: { effort: "max" } })),
    ).toMatchObject({ value: "xhigh", direction: "lowered" });
  });

  it("does nothing when the session is already there", () => {
    expect(
      effortChangeFor(session(ask, { modelSettings: { effort: "xhigh" } })),
    ).toBeNull();
  });

  it("leaves a legacy effort it cannot rank alone", () => {
    expect(
      effortChangeFor(session(ask, { modelSettings: { effort: "ultracode" } })),
    ).toBeNull();
  });

  it("ignores a level the model does not offer", () => {
    const blocks = [
      block("user", "go"),
      block("assistant", "Effort: high now, turbo needed (x)"),
    ];
    expect(effortChangeFor(session(blocks))).toBeNull();
  });

  it("works when options run low to high, for other harnesses", () => {
    const blocks = [
      block("user", "go"),
      block("assistant", "Effort: low now, max needed (x)"),
    ];
    const deepseek = {
      harness: "deepseek",
      model: "deepseek:deepseek-official/deepseek-v4-flash",
    } as const;
    expect(
      effortChangeFor(
        session(blocks, { ...deepseek, modelSettings: { effort: "low" } }),
      )?.value,
    ).toBe("max");
    expect(
      effortChangeFor(
        session(blocks, { ...deepseek, modelSettings: { effort: "off" } }),
      )?.direction,
    ).toBe("raised");
  });

  it("uses the model's default when the session has no value", () => {
    expect(effortChangeFor(session(ask, { modelSettings: {} }))?.value).toBe(
      "xhigh",
    );
  });

  it("ignores a line from before the user's last message", () => {
    expect(
      effortChangeFor(session([...ask, block("user", "next")])),
    ).toBeNull();
  });

  it("does not count a mid-turn follow-up or a queued message as a new turn", () => {
    const followUp = block("user", "also this", { sentAt: 1 });
    expect(effortChangeFor(session([...ask, followUp]))?.value).toBe("xhigh");

    const queued = block("user", "later");
    expect(
      effortChangeFor(
        session([...ask, queued], {
          queuedMessages: [
            { blockId: queued.id },
          ] as Session["queuedMessages"],
        }),
      )?.value,
    ).toBe("xhigh");
  });

  it("reads a plan-mode reply moved to a plan block", () => {
    const blocks = [block("user", "go"), block("plan", `${LINE}\n\n# Plan`)];
    expect(effortChangeFor(session(blocks))?.value).toBe("xhigh");
  });

  it("skips Monos, habit runs, pending switches and unknown models", () => {
    expect(effortChangeFor(session(ask, { ephemeral: true }))).toBeNull();
    expect(
      effortChangeFor(
        session(ask, { pendingSwitch: {} as Session["pendingSwitch"] }),
      ),
    ).toBeNull();
    expect(effortChangeFor(session(ask, { model: "nope" }))).toBeNull();
  });
});

describe("effortChangesOfEndedTurns", () => {
  const ask = [block("user", "go"), block("assistant", LINE)];

  function run(
    states: Session[],
    wasBusy = new Set<string>(),
    seen = new Map<string, string>(),
  ) {
    return states.map((state) =>
      effortChangesOfEndedTurns([state], wasBusy, seen).get(state.id)?.value,
    );
  }

  it("applies when a turn ends", () => {
    expect(
      run([session(ask, { busy: true }), session(ask)]),
    ).toEqual([undefined, "xhigh"]);
  });

  it("does not read a turn twice when busy flips again", () => {
    expect(
      run([
        session(ask, { busy: true }),
        session(ask),
        session(ask, { busy: true }),
        session(ask),
      ]),
    ).toEqual([undefined, "xhigh", undefined, undefined]);
  });

  it("does not replay a turn that asked for nothing over a manual choice", () => {
    const already = { modelSettings: { effort: "xhigh" } };
    const manual = { modelSettings: { effort: "low" } };
    expect(
      run([
        session(ask, { ...already, busy: true }),
        session(ask, already),
        session(ask, { ...manual, busy: true }),
        session(ask, manual),
      ]),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("does not read the old turn of a session first seen idle", () => {
    expect(
      run([session(ask), session(ask, { busy: true }), session(ask)]),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("reads the next turn after an earlier one", () => {
    const next = [...ask, block("user", "next"), block("assistant", LINE)];
    expect(
      run([session(ask), session(next, { busy: true }), session(next)]),
    ).toEqual([undefined, undefined, "xhigh"]);
  });
});

describe("sessionsGoneIdle", () => {
  it("reports only busy to idle, once", () => {
    const wasBusy = new Set<string>();
    expect(
      sessionsGoneIdle(
        [
          { id: "a", busy: true },
          { id: "b", busy: false },
        ],
        wasBusy,
      ),
    ).toEqual(new Set());
    expect(
      sessionsGoneIdle(
        [
          { id: "a", busy: false },
          { id: "b", busy: false },
        ],
        wasBusy,
      ),
    ).toEqual(new Set(["a"]));
    expect(sessionsGoneIdle([{ id: "a", busy: false }], wasBusy)).toEqual(
      new Set(),
    );
  });
});

describe("withEffortChange", () => {
  const change = {
    settingId: "effort",
    value: "xhigh",
    direction: "raised",
  } as const;

  it("keeps other settings and leaves a note", () => {
    const before = session([block("user", "go")], {
      modelSettings: { effort: "high", ultracode: "true" },
    });
    const after = withEffortChange(before, change);
    expect(after.modelSettings).toEqual({ effort: "xhigh", ultracode: "true" });
    expect(after.blocks.at(-1)).toMatchObject({
      role: "system",
      text: "Effort raised to xhigh (model asked)",
    });
  });

  it("words a lowering", () => {
    const after = withEffortChange(session([]), {
      ...change,
      value: "low",
      direction: "lowered",
    });
    expect(after.blocks.at(-1)?.text).toBe(
      "Effort lowered to low (model asked)",
    );
  });
});

describe("effortAutoFor", () => {
  it("is off under the test runner", () => {
    expect(effortAutoFor("s1")).toBe(false);
  });
});
