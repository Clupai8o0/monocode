import { Check } from "../../shared/ui/icons";
import type { ProviderAccount } from "../../features/providers/model/providerAccounts";
import { footerAccountLabel } from "../usage/FooterUsage";
import { resolveAutoAccount } from "./autoResolver";

/**
 * Fork: the "Auto" row at the top of the Claude account picker. It shows
 * which account Auto would start the next session on.
 */
export function AutoAccountRow({
  selected,
  accounts,
  onSelect,
}: {
  selected: boolean;
  /** This provider's accounts, of which Auto names its current pick. */
  accounts: ProviderAccount[];
  onSelect: () => void;
}) {
  const provider = accounts[0]?.provider === "codex" ? "codex" : "claude";
  const pickId = resolveAutoAccount(provider);
  const pick = accounts.find((account) => account.id === pickId) ?? accounts[0];
  const pickLabel = pick ? footerAccountLabel(pick) : "main";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[11px] ring-1 ring-inset transition-[background-color,transform] duration-150 ease-out active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-accent ${
        selected
          ? "bg-accent/10 text-content ring-accent/20"
          : "bg-content/[0.035] text-content/70 ring-content/[0.06] hover:bg-content/[0.06]"
      }`}
    >
      <span className="min-w-0 flex-1 py-0.5">
        <span className="block">Auto</span>
        <span className="mt-1 block truncate text-[10px] text-content/40">
          New sessions start on the account with the most headroom · now{" "}
          {pickLabel}
        </span>
      </span>
      {selected ? (
        <Check
          className="size-3.5 shrink-0 text-accent"
          strokeWidth={1.9}
          aria-hidden
        />
      ) : null}
    </button>
  );
}
