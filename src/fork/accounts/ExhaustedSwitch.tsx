import { ChevronRight } from "../../shared/ui/icons";
import {
  providerAccounts,
  type ProviderAccountProvider,
} from "../../features/providers/model/providerAccounts";
import { footerAccountLabel } from "../usage/FooterUsage";
import { exhaustedSwitchFor, useAutoAccountUsage } from "./autoResolver";
import { useAccountHomes } from "./accountHomes";

/**
 * Fork: when this session's account has used up its limit, one tap moves
 * the session to the account with headroom. Nothing switches on its own.
 */
export function ExhaustedSwitch({
  provider,
  accountId,
  exhausted,
  onSwitch,
}: {
  provider: ProviderAccountProvider;
  /** The account the session is pinned to. */
  accountId: string;
  /** This account's own tone is exhausted. */
  exhausted: boolean;
  onSwitch: (accountId: string) => void;
}) {
  const multiple = providerAccounts(provider).length > 1;
  useAccountHomes(multiple);
  useAutoAccountUsage(provider, exhausted && multiple);
  const target = exhausted && multiple ? exhaustedSwitchFor(provider, accountId) : null;
  const account = target
    ? providerAccounts(provider).find((entry) => entry.id === target)
    : undefined;
  if (!account) {
    return null;
  }
  const label = footerAccountLabel(account);
  return (
    <button
      type="button"
      onClick={() => onSwitch(account.id)}
      title={`This account is out of usage. Carry this conversation to ${label}; it keeps its history.`}
      className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-amber-400/12 px-1.5 text-[11px] text-amber-700 transition-[background-color,transform] duration-150 ease-out hover:bg-amber-400/20 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-accent dark:text-amber-300"
    >
      Switch this session to {label}
      <ChevronRight className="size-3" strokeWidth={1.75} aria-hidden />
    </button>
  );
}
