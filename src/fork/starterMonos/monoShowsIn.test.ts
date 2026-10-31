import { describe, expect, it } from "vitest";
import { monoShowsIn } from "./monoShowsIn";

describe("monoShowsIn", () => {
  it("shows a Mono with no project in every project", () => {
    expect(monoShowsIn({ projects: [] }, "/a")).toBe(true);
  });
  it("shows a Mono with projects only in those", () => {
    expect(monoShowsIn({ projects: ["/a"] }, "/a/")).toBe(true);
    expect(monoShowsIn({ projects: ["/a"] }, "/b")).toBe(false);
  });
});
