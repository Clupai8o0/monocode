import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LAYER } from "../../shared/lib/layers";
import { Check, ChevronDown } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { ALL_GAMES, GAME_GROUPS, gameEntry, type GameEntry } from "./catalog";
import { useGamePopup } from "./ChipSelect";
import { liveScore } from "./liveScore";

/**
 * Fork: choosing a game. Twenty games don't fit a plain dropdown, so they're
 * grouped in two columns with a search box, and the list scrolls inside the
 * window instead of running off the bottom of it.
 */

const WIDTH = 372;
const MAX_HEIGHT = 440;

/** The games that match, in the order the picker draws them. */
export function pickerGames(query: string): GameEntry[]
{
    const wanted = query.trim().toLowerCase();
    return GAME_GROUPS.flatMap((group) =>
        ALL_GAMES.filter(
            (game) =>
                game.group === group.id &&
                (!wanted ||
                    game.label.includes(wanted) ||
                    group.label.toLowerCase().includes(wanted)),
        ),
    );
}

export function GamePicker({
    value,
    onPick,
    onOpenChange,
    onHover,
}: {
    value: string;
    onPick: (id: string) => void;
    onOpenChange: (open: boolean) => void;
    /** A pointer resting on a game, so it can start loading before the click. */
    onHover?: (id: string) => void;
})
{
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const hadFocus = useRef<HTMLElement | null>(null);
    useGamePopup(open);

    const show = (next: boolean) => {
        setOpen(next);
        onOpenChange(next);
    };

    const openList = () => {
        const focus = document.activeElement;
        hadFocus.current = focus instanceof HTMLElement ? focus : null;
        show(true);
    };

    /** Closing without picking gives the keyboard back to whatever had it. */
    const closeAndReturn = () => {
        show(false);
        const target = hadFocus.current;
        hadFocus.current = null;
        if (target?.isConnected) {
            target.focus();
        }
    };

    return (
        <>
            <button
                ref={anchor}
                type="button"
                tabIndex={-1}
                aria-label="Game"
                title="Game"
                aria-haspopup="listbox"
                aria-expanded={open}
                data-fork-chip-select="Game"
                className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded pr-1.5 pl-2 text-[12px] font-medium leading-none text-content transition-colors duration-100 hover:bg-content/10 ${
                    open ? "bg-content/10" : ""
                }`}
                onClick={() => (open ? closeAndReturn() : openList())}
            >
                {gameEntry(value)?.label ?? value}
                <ChevronDown
                    className={`size-3 text-content/45 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
                    strokeWidth={2}
                    aria-hidden
                />
            </button>
            {open ? (
                <Popover
                    bare
                    anchor={anchor}
                    side="bottom"
                    align="start"
                    gap={4}
                    width={WIDTH}
                    minHeight={220}
                    maxHeight={MAX_HEIGHT}
                    layer={LAYER.submenu}
                    ignore='[data-fork-chip-select="Game"]'
                    className="games-popup flex flex-col overflow-hidden"
                    // React events cross the portal: the header above would
                    // otherwise cancel every press in here, the search box's too.
                    onMouseDown={(event) => event.stopPropagation()}
                    onDismiss={(reason) => {
                        if (reason === "escape") {
                            closeAndReturn();
                            return;
                        }
                        // Clicked elsewhere, and the click keeps what it landed on.
                        hadFocus.current = null;
                        show(false);
                    }}
                >
                    <PickerList
                        value={value}
                        onHover={onHover}
                        onPick={(id) => {
                            hadFocus.current = null;
                            show(false);
                            onPick(id);
                        }}
                    />
                </Popover>
            ) : null}
        </>
    );
}

function PickerList({
    value,
    onPick,
    onHover,
}: {
    value: string;
    onPick: (id: string) => void;
    onHover?: (id: string) => void;
})
{
    const idBase = useId();
    const listId = `${idBase}-list`;
    const optionId = (id: string) => `${idBase}-${id}`;
    const search = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [activeId, setActiveId] = useState(value);
    // Arrow keys scroll the row into view; a pointer is already looking at it.
    const byKey = useRef(true);
    // Read once: the game is paused behind this, so the scores hold still.
    const best = useMemo(() => liveScore().best, []);

    // The popover measures itself hidden, and a hidden box can't take focus, so
    // this waits until it's been placed.
    useEffect(() => {
        const frame = requestAnimationFrame(() => search.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    const games = useMemo(() => pickerGames(query), [query]);
    const shown = games.some((game) => game.id === activeId)
        ? activeId
        : games[0]?.id ?? null;

    useEffect(() => {
        if (!byKey.current || !shown) {
            return;
        }
        document
            .getElementById(optionId(shown))
            ?.scrollIntoView({ block: "nearest" });
        // optionId is derived from a stable id.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown]);

    const move = (step: number) => {
        if (!games.length) {
            return;
        }
        const from = games.findIndex((game) => game.id === shown);
        const next = games[(from + step + games.length) % games.length];
        if (next) {
            byKey.current = true;
            setActiveId(next.id);
        }
    };

    return (
        <>
            <div className="shrink-0 p-1.5 pb-0">
                <input
                    ref={search}
                    type="text"
                    role="combobox"
                    aria-label="Find a game"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={shown ? optionId(shown) : undefined}
                    aria-autocomplete="list"
                    placeholder="Find a game"
                    spellCheck={false}
                    autoComplete="off"
                    value={query}
                    data-fork-game-search=""
                    className="h-7 w-full rounded bg-content/[0.06] px-2 text-[12px] text-content placeholder:text-content/40 focus:outline-none"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            move(1);
                        } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            move(-1);
                        } else if (event.key === "Enter" && shown) {
                            event.preventDefault();
                            onPick(shown);
                        }
                    }}
                />
            </div>
            <div
                id={listId}
                role="listbox"
                aria-label="Game"
                className="min-h-0 flex-1 overflow-y-auto p-1.5"
                // Keeps the keyboard in the search box.
                onMouseDown={(event) => event.preventDefault()}
            >
                {games.length ? (
                    <div className="columns-2 gap-x-1.5">
                        {GAME_GROUPS.map((group) => {
                            const rows = games.filter((game) => game.group === group.id);
                            if (!rows.length) {
                                return null;
                            }
                            return (
                                <div
                                    key={group.id}
                                    role="group"
                                    aria-label={group.label}
                                    className="break-inside-avoid pb-1.5"
                                >
                                    <div
                                        aria-hidden="true"
                                        className="px-2 pt-1 pb-0.5 text-[11px] text-content/40"
                                    >
                                        {group.label}
                                    </div>
                                    {rows.map((game) => (
                                        <PickerRow
                                            key={game.id}
                                            id={optionId(game.id)}
                                            game={game}
                                            best={best[game.id] ?? 0}
                                            selected={game.id === value}
                                            active={game.id === shown}
                                            onEnter={() => {
                                                byKey.current = false;
                                                setActiveId(game.id);
                                                onHover?.(game.id);
                                            }}
                                            onPick={() => onPick(game.id)}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="px-2 py-6 text-center text-[12px] text-content/45">
                        No game matches that.
                    </p>
                )}
            </div>
        </>
    );
}

function PickerRow({
    id,
    game,
    best,
    selected,
    active,
    onEnter,
    onPick,
}: {
    id: string;
    game: GameEntry;
    best: number;
    selected: boolean;
    active: boolean;
    onEnter: () => void;
    onPick: () => void;
})
{
    return (
        <button
            id={id}
            type="button"
            role="option"
            tabIndex={-1}
            aria-label={game.label}
            aria-selected={selected}
            className={`flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-left text-[12px] ${
                active ? "bg-content/10 text-content" : selected ? "text-content" : "text-content/70"
            }`}
            onPointerEnter={onEnter}
            onClick={onPick}
        >
            <span className="min-w-0 truncate">{game.label}</span>
            {selected ? (
                <Check className="size-3 shrink-0 text-accent" strokeWidth={2} aria-hidden />
            ) : null}
            {best > 0 ? (
                <span
                    aria-hidden="true"
                    title={`Best ${best}`}
                    className="ml-auto font-mono text-[11px] tabular-nums text-content/35"
                >
                    {best}
                </span>
            ) : null}
        </button>
    );
}
