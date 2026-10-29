import { useEffect, useState } from "react";
import { Loader, Plus } from "../../shared/ui/icons";
import { projectName } from "../../shared/lib/paths";
import {
  AUTO_PROVIDER_ACCOUNT_ID,
  newProviderAccount,
  providerAccountChoice,
  providerAccountExists,
  providerAccounts,
  saveProviderAccount,
  selectProviderAccount,
  subscribeProviderAccounts,
} from "../../features/providers/model/providerAccounts";
import { removeProviderAccountCredentials } from "../../features/providers/model/providerAccountCredentials";
import { footerAccountLabel } from "../usage/FooterUsage";
import {
  canAddCxAccount,
  linkCxAccount,
  loadAccountHomes,
  useAccountHomes,
} from "./accountHomes";
import { resolveAutoAccount } from "./autoResolver";

/**
 * Fork: under the Claude accounts in Settings > Providers. Picks which
 * account new sessions in the current project start on (main, cx or Auto)
 * and offers to add the cx login (~/.claude-exec) as an account when none
 * points at it yet.
 */
export function ClaudeAccountSettings({
  project,
  disabled,
}: {
  project?: string;
  disabled: boolean;
}) {
  const homes = useAccountHomes();
  // A link made outside MonoCode shows up the next time Settings opens.
  useEffect(() => {
    void loadAccountHomes();
  }, []);
  // An account removed (or added) elsewhere changes which links exist, so
  // "Add cx account" comes back once the cx account is gone.
  useEffect(
    () =>
      subscribeProviderAccounts(() => {
        void loadAccountHomes();
      }),
    [],
  );
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = providerAccounts("claude");
  const choice = providerAccountChoice("claude", project);
  const autoPick = accounts.find(
    (account) => account.id === resolveAutoAccount("claude"),
  );

  const addCx = async () => {
    setAdding(true);
    setError(null);
    try {
      const account = newProviderAccount("claude", "cx");
      await linkCxAccount(account.id);
      try {
        saveProviderAccount(account);
        if (!providerAccountExists("claude", account.id)) {
          throw new Error("Could not save the cx account");
        }
      } catch (saveError) {
        // Roll back: drop the link (only the link; cx's login is untouched)
        // so no orphan folder is left behind.
        await removeProviderAccountCredentials("claude", account.id).catch(
          () => undefined,
        );
        await loadAccountHomes();
        throw saveError;
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : String(caught || "Could not add the cx account"),
      );
    } finally {
      setAdding(false);
    }
  };

  const options = [
    {
      id: AUTO_PROVIDER_ACCOUNT_ID,
      label: "Auto",
      title: `The account with the most headroom when each session starts${autoPick ? ` (now ${footerAccountLabel(autoPick)})` : ""}`,
    },
    ...accounts.map((account) => ({
      id: account.id,
      label: footerAccountLabel(account),
      title: account.label,
    })),
  ];

  if (accounts.length < 2 && !canAddCxAccount(homes) && !error) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2.5 py-3 pl-14 pr-4">
      {accounts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[11px] text-content/45">
            New sessions{project ? ` in ${projectName(project)}` : ""} start on
          </span>
          <div
            role="radiogroup"
            aria-label="Account for new Claude sessions"
            className="inline-flex rounded-md bg-content/[0.05] p-0.5"
          >
            {options.map((option) => {
              const selected = option.id === choice;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={option.title}
                  disabled={disabled}
                  onClick={() => selectProviderAccount("claude", project, option.id)}
                  className={`h-6 max-w-[9rem] truncate rounded-[4.5px] px-2.5 text-[11px] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-40 ${
                    selected
                      ? "bg-content text-background-base"
                      : "text-content/55 hover:bg-content/10 hover:text-content"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {choice === AUTO_PROVIDER_ACCOUNT_ID && autoPick ? (
            <span className="text-[10px] text-content/35">
              next: {footerAccountLabel(autoPick)}
            </span>
          ) : null}
        </div>
      ) : null}
      {canAddCxAccount(homes) ? (
        <button
          type="button"
          disabled={disabled || adding}
          onClick={() => void addCx()}
          className="flex w-fit items-center gap-1.5 rounded-md bg-content/[0.05] px-2.5 py-1 text-[12px] text-content/70 transition-[background-color,transform] duration-150 ease-out hover:bg-content/10 hover:text-content active:scale-[0.97] disabled:opacity-40"
        >
          {adding ? (
            <Loader className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
          )}
          Add cx account ({homes.cxHome})
        </button>
      ) : null}
      {error ? (
        <p className="text-[11px] leading-4 text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
