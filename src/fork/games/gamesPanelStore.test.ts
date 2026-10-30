import { describe, expect, it } from "vitest";
import { activityLabel, activityNotice } from "./gamesPanelStore";

describe("activityLabel", () => {
  it("says who is working and who is waiting", () => {
    expect(activityLabel({ working: 0, waiting: 0 })).toBe("");
    expect(activityLabel({ working: 1, waiting: 0 })).toBe("1 agent working");
    expect(activityLabel({ working: 2, waiting: 1 })).toBe(
      "2 agents working · 1 needs you",
    );
  });
});

describe("activityNotice", () => {
  it("stops the game when an agent starts waiting", () => {
    expect(
      activityNotice({ working: 2, waiting: 0 }, { working: 1, waiting: 1 }),
    ).toBe("An agent needs you");
  });

  it("stops the game when the last agent finishes", () => {
    expect(
      activityNotice({ working: 1, waiting: 0 }, { working: 0, waiting: 0 }),
    ).toBe("Agents finished");
  });

  it("stays quiet otherwise", () => {
    expect(
      activityNotice({ working: 2, waiting: 0 }, { working: 1, waiting: 0 }),
    ).toBeNull();
    expect(
      activityNotice({ working: 0, waiting: 0 }, { working: 1, waiting: 0 }),
    ).toBeNull();
    expect(
      activityNotice({ working: 0, waiting: 1 }, { working: 0, waiting: 0 }),
    ).toBeNull();
  });
});
