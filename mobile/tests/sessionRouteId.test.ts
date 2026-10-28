import { describe, expect, it } from "vitest";

import { sessionIdFromRoute, sessionIdToRoute } from "@/features/sessions/externalSessions";

// What Expo Router does to a pushed dynamic param: encodes it into the path,
// decodes it reading the path, then decodes it again in useLocalSearchParams.
const throughRouter = (param: string) =>
  decodeURIComponent(decodeURIComponent(encodeURIComponent(param)));

describe("session ids in routes", () => {
  it.each([
    "handoff:.claude/handoff-x.md",
    "handoff:.claude/handoff-monocode-16.md",
    "100%25done%",
    "tilde~%7E",
    "a1B2c3D4-e5_f6",
  ])("round-trips %s", (id) => {
    const param = sessionIdToRoute(id);
    expect(param).not.toMatch(/[%/]/);
    expect(sessionIdFromRoute(throughRouter(param))).toBe(id);
  });

  it("leaves a plain id as it is", () => {
    expect(sessionIdToRoute("a1B2c3D4-e5_f6")).toBe("a1B2c3D4-e5_f6");
  });
});
