import { useRef, type KeyboardEvent } from "react";
import { ServerStack } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { useZonePickerOpen } from "../lab/agentTimeZone";
import { LabButton } from "../lab/LabButton";
import { StacksButton } from "../stacks/StacksButton";
import {
  closeMachines,
  MACHINE_TABS,
  machinesHover,
  openMachines,
  pickMachineTab,
  setMachinesHost,
  useMachineSignals,
  useMachinesOpen,
  useMachineTab,
  worstTone,
  type MachineTone,
} from "./machinesStore";

/** Off under the test runner, so upstream footer tests see no extra button. */
export const FORK_MACHINES = import.meta.env.MODE !== "test";

export const TONE_DOT: Record<MachineTone, string> = {
  amber: "bg-amber-400",
  red: "bg-red-500",
};

/**
 * Fork: footer chip "Machines". One popover with three tabs, Lab, Stacks and
 * Memory. Its dot takes the worst of the three; the hover text says why.
 * MemoryWatcher is mounted by App, because it needs the sessions.
 */
export function MachinesButton({ inset = false }: { inset?: boolean }) {
  return FORK_MACHINES ? <Machines inset={inset} /> : null;
}

function Machines({ inset }: { inset: boolean }) {
  const signals = useMachineSignals();
  const open = useMachinesOpen();
  const tab = useMachineTab();
  // Escape in the zone search closes the search, not the popover.
  const pickerOpen = useZonePickerOpen();
  const anchor = useRef<HTMLButtonElement>(null);
  const tone = worstTone(signals);
  const hover = machinesHover(signals);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) {
      return;
    }
    event.preventDefault();
    const at = MACHINE_TABS.findIndex(({ id }) => id === tab);
    const next = MACHINE_TABS[(at + step + MACHINE_TABS.length) % MACHINE_TABS.length];
    pickMachineTab(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-fork-${next.id}]`)?.focus();
  };

  return (
    <>
      <LabButton />
      <StacksButton />
      <button
        ref={anchor}
        type="button"
        data-fork-machines=""
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap hover:bg-content/10 ${
          inset ? "rounded-full px-2" : "rounded px-1.5"
        } ${
          open
            ? "text-accent"
            : tone
              ? "text-content/70 hover:text-content"
              : "text-content/40 hover:text-content"
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Machines: ${hover}`}
        title={hover}
        onClick={() => (open ? closeMachines() : openMachines())}
      >
        <ServerStack className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="hidden min-[1100px]:inline">Machines</span>
        {/* Always there, so the chip keeps its width when the dot comes on. */}
        <span
          data-fork-machines-dot={tone ?? ""}
          className={`size-1.5 shrink-0 rounded-full ${tone ? TONE_DOT[tone] : "invisible"}`}
          aria-hidden
        />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={360}
          ignore="[data-fork-machines]"
          autoFocus
          tabIndex={-1}
          dismissOnEscape={!pickerOpen}
          aria-label="Machines"
          className="flex flex-col"
          onDismiss={(reason) => {
            closeMachines();
            if (reason === "escape") {
              anchor.current?.focus();
            }
          }}
        >
          <div
            role="tablist"
            aria-label="Machines"
            className="mx-2 mt-2 flex shrink-0 gap-0.5 rounded-md bg-content/5 p-0.5 text-[12px]"
            onKeyDown={onTabKey}
          >
            {MACHINE_TABS.map(({ id, label }) => {
              const selected = tab === id;
              const lit = signals[id].tone;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  {...{ [`data-fork-${id}`]: "" }}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  title={lit ? signals[id].why : undefined}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded px-1.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                    selected ? "bg-content/10 font-semibold text-content" : "text-content/60 hover:text-content"
                  }`}
                  onClick={() => pickMachineTab(id)}
                >
                  {label}
                  {lit ? (
                    <span
                      data-fork-machines-tab-dot={lit}
                      className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[lit]}`}
                      aria-hidden
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
          <div
            ref={setMachinesHost}
            role="tabpanel"
            aria-label={MACHINE_TABS.find(({ id }) => id === tab)?.label}
            className="max-h-[520px] min-h-0 flex-1 overflow-y-auto"
          />
        </Popover>
      ) : null}
    </>
  );
}
