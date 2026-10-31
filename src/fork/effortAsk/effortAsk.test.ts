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
  resumeText,
  resumeLevelFor,
  resumeIntentFor,
  noteEffortStop,
  sessionsGoneIdle,
  stoppedAtEffortLine,
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

describe("stoppedAtEffortLine", () => {
  it("is true when the reply is the line alone", () => {
    expect(stoppedAtEffortLine([block("reasoning", "hm"), block("assistant", LINE)])).toBe(true);
  });

  it("allows status notes before the line", () => {
    expect(stoppedAtEffortLine([block("system", "Compacted"), block("assistant", LINE)])).toBe(true);
  });

  it("is false for a short finished answer after the line, or on it", () => {
    expect(stoppedAtEffortLine([block("assistant", `${LINE}\nNo findings.`)])).toBe(false);
    expect(stoppedAtEffortLine([block("assistant", `${LINE} No findings.`)])).toBe(false);
    expect(stoppedAtEffortLine([block("assistant", `**${LINE}**`)])).toBe(true);
  });

  it("is false once the model did work after the line", () => {
    expect(stoppedAtEffortLine([block("assistant", LINE), block("tool", "ls")])).toBe(false);
    expect(
      stoppedAtEffortLine([block("assistant", `${LINE}\n${"answer ".repeat(60)}`)]),
    ).toBe(false);
  });

  it("is false when the turn was interrupted after the line", () => {
    expect(
      stoppedAtEffortLine([
        block("assistant", LINE),
        block("system", "Interrupted", { notice: "interrupt" } as Partial<Block>),
      ]),
    ).toBe(false);
  });

  it("is false when work came before the line", () => {
    expect(stoppedAtEffortLine([block("tool", "ls"), block("assistant", LINE)])).toBe(false);
  });
});

describe("resume after a raise", () => {
  const stopped = [block("user", "build it"), block("assistant", LINE)];
  const resumeOf = (s: Session) => resumeLevelFor(s, effortChangeFor(s));

  it("sends the turn on at the new level when the model stopped for a raise", () => {
    expect(resumeOf(session(stopped))).toBe("xhigh");
    expect(resumeText("xhigh")).toBe("Continue at xhigh effort.");
  });

  it("does not send on when the line asked for less", () => {
    expect(
      resumeOf(
        session([block("user", "x"), block("assistant", "Effort: max now, low needed (x).")], {
          modelSettings: { effort: "max" },
        }),
      ),
    ).toBeNull();
  });

  it("does not send on when the user already queued a message", () => {
    expect(
      resumeOf(session(stopped, { queuedMessages: [{ blockId: "other" }] } as Partial<Session>)),
    ).toBeNull();
  });

  it("does not send on when the model did the work anyway", () => {
    expect(
      resumeOf(session([...stopped, block("tool", "ls"), block("assistant", "Done.")])),
    ).toBeNull();
  });
});

describe("resumeLevelFor", () => {
  const staleLine = "Effort: low now, high needed (big build).";
  const stale = (first: string, extra?: Partial<Session>) =>
    session([block("user", first), block("assistant", staleLine)], extra);

  it("sends on once when the session already has the needed level", () => {
    expect(resumeLevelFor(stale("build it"), null)).toBe("high");
  });

  it("never answers its own send without a change, so a stale level cannot loop", () => {
    expect(resumeLevelFor(stale(resumeText("high")), null)).toBeNull();
  });

  it("follows the line, not the session: a stale low asking medium still resumes", () => {
    const s = session(
      [block("user", "x"), block("assistant", "Effort: low now, medium needed (x).")],
      { modelSettings: { effort: "high" } },
    );
    const change = effortChangeFor(s);
    expect(resumeLevelFor(s, change)).toBe(change?.value ?? "high");
  });

  it("is null when the line did not ask for more or the model kept working", () => {
    expect(
      resumeLevelFor(
        session([block("user", "x"), block("assistant", "Effort: high now, high needed (x).")]),
        null,
      ),
    ).toBeNull();
    expect(
      resumeLevelFor(
        session([block("user", "x"), block("assistant", staleLine), block("tool", "ls")]),
        null,
      ),
    ).toBeNull();
  });

  it("resumes a plan-mode turn in plan mode", () => {
    const s = session([
      block("user", "plan auth", { intent: "plan" } as Partial<Block>),
      block("plan", LINE),
    ]);
    expect(resumeLevelFor(s, effortChangeFor(s))).toBe("xhigh");
    expect(resumeIntentFor(s)).toBe("plan");
  });
});

describe("unsupported levels", () => {
  it("takes the nearest level above one the model lacks", () => {
    const s = session([block("user", "x"), block("assistant", "Effort: low now, medium needed (x).")], {
      modelSettings: { effort: "low" },
    });
    expect(effortChangeFor(s)?.value).toBe("high");
  });
});

describe("Stop", () => {
  it("does not send on a turn the user stopped", () => {
    const wasBusy = new Set<string>(["s1"]);
    const seen = new Map<string, string>([["s1", "old"]]);
    const user = block("user", "build it");
    const s = session([user, block("assistant", "Effort: high now, xhigh needed (x).")]);
    noteEffortStop("s1");
    const changes = effortChangesOfEndedTurns([s], wasBusy, seen, new Map());
    expect(changes.get("s1")?.resume).toBe(false);
  });

  it("sends on the same turn when nobody stopped it", () => {
    const s = session([block("user", "build it"), block("assistant", "Effort: high now, xhigh needed (x).")]);
    const changes = effortChangesOfEndedTurns([s], new Set(["s1"]), new Map([["s1", "old"]]), new Map());
    expect(changes.get("s1")?.resume).toBe(true);
  });
});
