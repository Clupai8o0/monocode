import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { ProviderAccount } from "../../features/providers/model/providerAccounts";

/**
 * Fork feature: which Claude login each account runs on. The stock account
 * is "main" (~/.claude); an account whose folder links to ~/.claude-exec is
 * "cx". Rust reads only the symlink targets (fork_account_homes).
 */

export type AccountRole = "main" | "cx" | "other";

export type AccountHome = { id: string; home: string; role: AccountRole };

export type AccountHomes = {
  accounts: AccountHome[];
  /** The cx login folder, when it exists on this Mac. */
  cxHome: string | null;
};

const EMPTY: AccountHomes = { accounts: [], cxHome: null };

let snapshot: AccountHomes = EMPTY;
let loading: Promise<AccountHomes> | null = null;
const listeners = new Set<() => void>();

export function getAccountHomes(): AccountHomes {
  return snapshot;
}

/** Replace the snapshot; tests use it in place of the native command. */
export function setAccountHomes(next: AccountHomes): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAccountHomes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the account folders again; concurrent calls share one read. */
export function loadAccountHomes(): Promise<AccountHomes> {
  if (loading) {
    return loading;
  }
  loading = invoke<AccountHomes>("fork_account_homes")
    .then((homes) => {
      setAccountHomes({
        accounts: Array.isArray(homes?.accounts) ? homes.accounts : [],
        cxHome: typeof homes?.cxHome === "string" ? homes.cxHome : null,
      });
      return snapshot;
    })
    .catch(() => snapshot)
    .finally(() => {
      loading = null;
    });
  return loading;
}

let loaded = false;

/** The homes snapshot, read from disk the first time it is wanted. */
export function useAccountHomes(enabled = true): AccountHomes {
  const homes = useSyncExternalStore(
    subscribeAccountHomes,
    getAccountHomes,
    getAccountHomes,
  );
  useEffect(() => {
    if (!enabled || loaded) {
      return;
    }
    loaded = true;
    void loadAccountHomes();
  }, [enabled]);
  return homes;
}

/** main for the stock Claude account, cx for one linked to ~/.claude-exec. */
export function accountRole(
  account: Pick<ProviderAccount, "id" | "provider" | "isDefault">,
  homes: AccountHomes = snapshot,
): AccountRole {
  if (account.provider !== "claude") {
    return "other";
  }
  if (account.isDefault || account.id === "default") {
    return "main";
  }
  return homes.accounts.find((entry) => entry.id === account.id)?.role ?? "other";
}

/** Names that only restate the login, so the label needs nothing more. */
const PLAIN_LABELS = new Set(["default account", "main", "cx"]);

/**
 * "main (~/.claude)" and "cx (~/.claude-exec)", led by a name the person
 * chose ("Work · cx (~/.claude-exec)"); other accounts keep their own name.
 */
export function accountDisplayLabel(
  account: ProviderAccount,
  homes: AccountHomes = snapshot,
): string {
  const role = accountRole(account, homes);
  if (role === "other") {
    return account.label;
  }
  const home =
    role === "main"
      ? "~/.claude"
      : (homes.accounts.find((entry) => entry.id === account.id)?.home ??
        "~/.claude-exec");
  const login = `${role} (${home})`;
  return PLAIN_LABELS.has(account.label.trim().toLowerCase())
    ? login
    : `${account.label} · ${login}`;
}

/** Whether Settings should offer to add the cx login as an account. */
export function canAddCxAccount(homes: AccountHomes = snapshot): boolean {
  return (
    homes.cxHome != null && !homes.accounts.some((entry) => entry.role === "cx")
  );
}

/** Link a new account folder to ~/.claude-exec. Nothing is copied. */
export async function linkCxAccount(accountId: string): Promise<void> {
  await invoke("fork_add_cx_account", { accountId });
  await loadAccountHomes();
}
