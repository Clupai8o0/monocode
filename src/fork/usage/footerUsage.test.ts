import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FooterUsage, footerAccountLabel } from "./FooterUsage";
import type { RateLimitWindow } from "../../features/providers/model/rateLimits";

describe("footerAccountLabel", () => {
  it("calls the default Claude login main", () => {
    expect(
      footerAccountLabel({
        id: "default",
        provider: "claude",
        label: "Default account",
        isDefault: true,
      }),
    ).toBe("main");
  });

  it("keeps a name the person chose and other providers' labels", () => {
    expect(
      footerAccountLabel({
        id: "default",
        provider: "claude",
        label: "Personal",
        isDefault: true,
      }),
    ).toBe("Personal");
    expect(
      footerAccountLabel({
        id: "default",
        provider: "codex",
        label: "Default account",
        isDefault: true,
      }),
    ).toBe("Default account");
  });
});

describe("FooterUsage", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0);
  const window = (
    usedPercent: number,
    windowMinutes: number,
    hours: number,
  ): RateLimitWindow =>
    ({
      usedPercent,
      windowMinutes,
      resetsAt: now + hours * 3600_000,
    }) as RateLimitWindow;
  const render = (showRemaining: boolean) =>
    renderToStaticMarkup(
      createElement(FooterUsage, {
        windows: [
          { key: "session", window: window(20, 300, 4.8) },
          { key: "weekly", window: window(95, 10080, 46) },
        ],
        now,
        showRemaining,
      }),
    );

  it("draws a bar per window with its reset time, not a percentage", () => {
    const html = render(false);
    expect(html).toContain("5h");
    expect(html).toContain("wk");
    expect(html).toContain("width:20%");
    expect(html).toContain("width:95%");
    expect(html).toContain("bg-red-400");
    // The percentage is only for screen readers.
    expect(html).toContain('<span class="sr-only">20%</span>');
  });

  it("fills the bar with what is left when the person prefers that", () => {
    expect(render(true)).toContain("width:80%");
  });
});
