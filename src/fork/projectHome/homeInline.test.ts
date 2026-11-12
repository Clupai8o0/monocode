import { afterEach, describe, expect, it, vi } from "vitest";
import {
  homeInlineData as current,
  setHomeInlineData,
  type HomeInlineData,
} from "./homeInline";

function data(): HomeInlineData {
  return {
    sessions: [],
    summaries: [],
    unseenIds: new Set(),
    onOpenChat: () => {},
    onOpenProjectHome: () => {},
    onOpenAllProjects: () => {},
    onOpenFile: () => {},
  };
}

describe("inline home data", () => {
  afterEach(() => {
    setHomeInlineData(null);
    vi.useRealTimers();
  });

  it("shows the first data at once and throttles changes after it", () => {
    vi.useFakeTimers();
    const first = data();
    const second = data();
    const third = data();
    setHomeInlineData(first);
    expect(current()).toBe(first);
    setHomeInlineData(second);
    setHomeInlineData(third);
    expect(current()).toBe(first);
    vi.advanceTimersByTime(1000);
    expect(current()).toBe(third);
  });

  it("turns off at once", () => {
    vi.useFakeTimers();
    setHomeInlineData(data());
    setHomeInlineData(data());
    setHomeInlineData(null);
    expect(current()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(current()).toBeNull();
  });
});
