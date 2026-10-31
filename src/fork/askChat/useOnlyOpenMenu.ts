import { useEffect, useRef } from "react";

const MENU_OPENED_EVENT = "monocode:ask-menu-opened";

/**
 * Events inside an iframe never reach this page, so the usual click-outside
 * cannot close another pane's menu. Only the newest selection menu stays open.
 */
export function useOnlyOpenMenu(open: boolean, onDismiss: () => void) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const token = {};
    window.dispatchEvent(new CustomEvent(MENU_OPENED_EVENT, { detail: token }));
    const onOtherOpened = (event: Event) => {
      if ((event as CustomEvent).detail !== token) onDismissRef.current();
    };
    window.addEventListener(MENU_OPENED_EVENT, onOtherOpened);
    return () => window.removeEventListener(MENU_OPENED_EVENT, onOtherOpened);
  }, [open]);
}
