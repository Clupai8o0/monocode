import { useRef, useState, type ComponentType } from "react";
import { LAYER } from "../../shared/lib/layers";
import { Check, ChevronDown, type IconProps } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";

/**
 * Fork: a small dropdown for the games panel's toolbars (game, difficulty,
 * language). The panel floats on the popover layer, so the list goes one up.
 */

export type ChipOption<T extends string> = { id: T; label: string };

export const ICON_BUTTON =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded text-content/55 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40";
export const ICON_BUTTON_ON = "bg-content/10 text-content";

export function ChipSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 150,
}: {
  label: string;
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (id: T) => void;
  width?: number;
})
{
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.id === value);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-fork-chip-select={label}
        className={`inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded pr-1 pl-2 text-[11px] leading-none text-content/80 hover:bg-content/10 hover:text-content ${
          open ? "bg-content/10 text-content" : "bg-content/5"
        }`}
        onClick={() => setOpen((was) => !was)}
      >
        {current?.label ?? value}
        <ChevronDown
          className={`size-3 text-content/45 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
          aria-hidden
        />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="start"
          gap={4}
          width={width}
          layer={LAYER.submenu}
          rounded="rounded-lg"
          constrainHeight={false}
          ignore={`[data-fork-chip-select="${label}"]`}
          onDismiss={() => setOpen(false)}
        >
          <div
            role="listbox"
            aria-label={label}
            className="flex flex-col p-1"
            // Keeps the keyboard where it was, as the toolbar does: the game
            // board, or the drill's editor.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option) => {
              const selected = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`flex h-7 cursor-pointer items-center justify-between gap-2 rounded px-2 text-left text-[12px] ${
                    selected
                      ? "text-content"
                      : "text-content/70 hover:bg-content/10 hover:text-content"
                  }`}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) {
                      onChange(option.id);
                    }
                  }}
                >
                  {option.label}
                  {selected ? (
                    <Check className="size-3.5 text-accent" strokeWidth={2} aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** An icon-only toolbar button; the label is its name and tooltip. */
export function IconButton({
  icon: Icon,
  label,
  pressed,
  onClick,
  ...data
}: {
  icon: ComponentType<IconProps>;
  label: string;
  pressed?: boolean;
  onClick: () => void;
} & Record<`data-${string}`, string>)
{
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`${ICON_BUTTON} ${pressed ? ICON_BUTTON_ON : ""}`}
      onClick={onClick}
      {...data}
    >
      <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
    </button>
  );
}
