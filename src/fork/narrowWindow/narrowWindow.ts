import { useEffect, useRef } from "react";

/**
 * Fork feature: a window tiled to half the screen leaves the chat a sliver
 * beside the sidebar. Below NARROW_BELOW the sidebar hides itself, without
 * saving that as the user's choice, and it comes back once the window is
 * WIDE_FROM or wider. The gap between the two keeps it from flickering while
 * a window is dragged across the line.
 */
export const NARROW_BELOW = 700;
export const WIDE_FROM = 740;

export type NarrowState = {
  /** This hid the sidebar, so it brings it back. */
  autoHidden: boolean;
  /** The user opened it while narrow; leave it until the window is wide. */
  userOpenedNarrow: boolean;
};

export function narrowState(): NarrowState {
  return { autoHidden: false, userOpenedNarrow: false };
}

/** What a window width asks for: hide the open sidebar, show the one this hid, or nothing. */
export function onWidth(
  state: NarrowState,
  width: number,
  open: boolean,
): "hide" | "show" | null {
  if (width >= WIDE_FROM) {
    state.userOpenedNarrow = false;
    const restore = state.autoHidden && !open;
    state.autoHidden = false;
    return restore ? "show" : null;
  }
  if (
    width < NARROW_BELOW &&
    open &&
    !state.autoHidden &&
    !state.userOpenedNarrow
  ) {
    state.autoHidden = true;
    return "hide";
  }
  return null;
}

/**
 * The user opened or closed the sidebar. Opened while narrow, it stays until
 * the window has been wide; closed, there is nothing left to bring back.
 */
export function onUserToggle(
  state: NarrowState,
  width: number,
  open: boolean,
) {
  state.autoHidden = false;
  state.userOpenedNarrow = open && width < WIDE_FROM;
}

/**
 * Hides the sidebar while the window is narrow and brings it back when it is
 * wide. `setOpen` must not save: the saved choice stays what the user picked.
 */
export function useNarrowWindowSidebar(
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  const state = useRef<NarrowState>(narrowState());
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };
  /** The value this asked for and has not seen yet, to tell it from the user's. */
  const pending = useRef<boolean | null>(null);
  const previous = useRef(open);

  useEffect(() => {
    const check = () => {
      const { open: isOpen, setOpen: set } = latest.current;
      const step = onWidth(state.current, window.innerWidth, isOpen);
      if (step) {
        const next = step === "show";
        // Back to what React last committed: nothing will arrive to match.
        pending.current = next === previous.current ? null : next;
        // Seen at once, so a resize before React commits reads the new value.
        latest.current.open = next;
        set(next);
      }
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (open === previous.current) {
      return;
    }
    previous.current = open;
    if (open === pending.current) {
      pending.current = null;
      return;
    }
    pending.current = null;
    onUserToggle(state.current, window.innerWidth, open);
  }, [open]);
}
