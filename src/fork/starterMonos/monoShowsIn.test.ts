import { describe, expect, it } from "vitest";
import { monoShowsIn } from "./monoShowsIn";

const none = () => false;

describe("monoShowsIn", () => {
  it("shows a Mono with no project in every project", () => {
    expect(monoShowsIn({ id: "m", projects: [] }, "/a", none)).toBe(true);
  });
  it("shows a Mono with projects only in those", () => {
    expect(monoShowsIn({ id: "m", projects: ["/a"] }, "/a/", none)).toBe(true);
    expect(monoShowsIn({ id: "m", projects: ["/a"] }, "/b", none)).toBe(false);
  });
  it("shows a starter Mono everywhere even after it made a project", () => {
    const starter = (id: string) => id === "kickoff";
    expect(monoShowsIn({ id: "kickoff", projects: ["/glow-up"] }, "/monocode", starter)).toBe(true);
    expect(monoShowsIn({ id: "other", projects: ["/glow-up"] }, "/monocode", starter)).toBe(false);
  });
});
