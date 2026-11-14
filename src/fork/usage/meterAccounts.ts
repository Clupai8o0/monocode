import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * Fork feature: logins MonoCode only meters and never runs sessions on, such
 * as a client's Codex seat. Each is a folder (usually a symlink to the CLI's
 * home) named `meter-<name>` under `provider-accounts/<provider>/`. It is
 * not in the account list, so Auto, the usage-limit switch and every picker
 * skip it; the All usage panel reads its windows like any account's.
 */
export type MeterAccount = {
  provider: "codex";
  id: string;
  /** Where the folder points, with `~` for the home folder. */
  home: string;
};

const PREFIX = "meter-";

export function isMeterAccount(value: unknown): value is MeterAccount {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.provider === "codex" &&
    typeof entry.id === "string" &&
    entry.id.startsWith(PREFIX) &&
    entry.id.length > PREFIX.length &&
    typeof entry.home === "string"
  );
}

/** "meter-codex-3" reads as "codex-3". */
export function meterAccountName(account: MeterAccount): string {
  return account.id.slice(PREFIX.length);
}

export async function loadMeterAccounts(): Promise<MeterAccount[]> {
  try {
    const found = await invoke<unknown>("fork_meter_accounts");
    return Array.isArray(found) ? found.filter(isMeterAccount) : [];
  } catch {
    return [];
  }
}

/** Read once per mount; a new meter folder shows the next time the panel opens. */
export function useMeterAccounts(): MeterAccount[] {
  const [accounts, setAccounts] = useState<MeterAccount[]>([]);
  useEffect(() => {
    let live = true;
    void loadMeterAccounts().then((found) => {
      if (live) setAccounts(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return accounts;
}
