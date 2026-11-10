import { describe, expect, it } from "vitest";
import { isMeterAccount, meterAccountName } from "./meterAccounts";

describe("meter accounts", () => {
  it("accepts only meter- folders for claude or codex", () => {
    expect(isMeterAccount({ provider: "codex", id: "meter-codex-3", home: "~/.codex-3" })).toBe(true);
    expect(isMeterAccount({ provider: "codex", id: "account-abc", home: "~/x" })).toBe(false);
    expect(isMeterAccount({ provider: "codex", id: "meter-", home: "~/x" })).toBe(false);
    expect(isMeterAccount({ provider: "cursor", id: "meter-x", home: "~/x" })).toBe(false);
    expect(isMeterAccount(null)).toBe(false);
  });

  it("names a meter by its folder without the prefix", () => {
    expect(meterAccountName({ provider: "codex", id: "meter-codex-3", home: "~/.codex-3" })).toBe("codex-3");
  });
});
