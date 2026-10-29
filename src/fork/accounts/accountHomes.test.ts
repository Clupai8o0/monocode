import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  accountDisplayLabel,
  accountRole,
  canAddCxAccount,
  getAccountHomes,
  loadAccountHomes,
  setAccountHomes,
  type AccountHomes,
} from "./accountHomes";
import { footerAccountLabel } from "../usage/FooterUsage";

const HOMES: AccountHomes = {
  accounts: [
    { id: "default", home: "~/.claude", role: "main" },
    { id: "account-cx", home: "~/.claude-exec", role: "cx" },
    { id: "account-work", home: "~/Library/x/account-work", role: "other" },
  ],
  cxHome: "~/.claude-exec",
};

const main = {
  id: "default",
  provider: "claude" as const,
  label: "Default account",
  isDefault: true,
};
const cx = { id: "account-cx", provider: "claude" as const, label: "cx" };
const work = { id: "account-work", provider: "claude" as const, label: "Work" };

beforeEach(() => {
  setAccountHomes({ accounts: [], cxHome: null });
  invoke.mockReset();
});

describe("account labels", () => {
  it("names the two logins after their folders", () => {
    setAccountHomes(HOMES);
    expect(accountDisplayLabel(main)).toBe("main (~/.claude)");
    expect(accountDisplayLabel(cx)).toBe("cx (~/.claude-exec)");
    expect(accountDisplayLabel(work)).toBe("Work");
    expect(footerAccountLabel(cx)).toBe("cx");
    expect(footerAccountLabel(main)).toBe("main");
  });

  it("keeps a name the person chose in front of the login", () => {
    setAccountHomes(HOMES);
    expect(accountDisplayLabel({ ...cx, label: "limbusamaka" })).toBe(
      "limbusamaka · cx (~/.claude-exec)",
    );
    expect(accountDisplayLabel({ ...main, label: "Personal" })).toBe(
      "Personal · main (~/.claude)",
    );
  });

  it("treats the stock account as main before the folders are read", () => {
    expect(accountRole(main)).toBe("main");
    expect(accountRole(cx)).toBe("other");
    expect(accountDisplayLabel(cx)).toBe("cx");
    expect(accountRole({ ...main, provider: "codex" })).toBe("other");
  });

  it("offers adding cx only when ~/.claude-exec exists and no account uses it", () => {
    expect(canAddCxAccount(HOMES)).toBe(false);
    expect(
      canAddCxAccount({ accounts: [HOMES.accounts[0]], cxHome: "~/.claude-exec" }),
    ).toBe(true);
    expect(canAddCxAccount({ accounts: [HOMES.accounts[0]], cxHome: null })).toBe(
      false,
    );
  });

  it("loads the folders from the native command and keeps the last on error", async () => {
    invoke.mockResolvedValueOnce(HOMES);
    await loadAccountHomes();
    expect(invoke).toHaveBeenCalledWith("fork_account_homes");
    expect(getAccountHomes().accounts).toHaveLength(3);
    invoke.mockRejectedValueOnce(new Error("nope"));
    await loadAccountHomes();
    expect(getAccountHomes().cxHome).toBe("~/.claude-exec");
  });
});
