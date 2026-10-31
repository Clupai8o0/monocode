import { useEffect, useState, type ReactNode } from "react";
import { requestAddToChat } from "../../features/sessions/model/quoteDraft";
import type { TranscriptSelection } from "../../features/sessions/model/transcriptSelection";
import { TranscriptSelectionMenu } from "../../features/sessions/ui/TranscriptSelectionMenu";
import type { AskChatDescribe } from "./askChatDescribe";
import { ASK_CHAT_ENABLED, useAskChatSelection } from "./useAskChatSelection";
import "./askChat.css";

const ASK_SELECTED_ATTR = "data-ask-selected";
const MENU_BUTTON =
  '[role="toolbar"][aria-label="Selected text actions"] button';

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** Where focus goes back to when the menu closes; an iframe counts. */
let focusBefore: HTMLElement | null = null;

/** Hands the keyboard to the floating button, which sits far off in tab order. */
export function focusAskChatButton(returnTo?: HTMLElement): boolean {
  const button = document.querySelector<HTMLElement>(MENU_BUTTON);
  if (!button) return false;
  const previous = document.activeElement;
  focusBefore = returnTo ?? (previous instanceof HTMLElement ? previous : null);
  button.focus();
  return true;
}

/**
 * The transcript's "Add to chat" menu, unchanged. Tab reaches it from the
 * selection (`tabToMenu`), Enter sends, Escape dismisses and focus goes back.
 */
export function AskChatMenu({
  selection,
  onDismiss,
  onAdded,
  tabToMenu = true,
  overWhitePage = false,
}: {
  selection: TranscriptSelection | null;
  onDismiss: () => void;
  onAdded?: () => void;
  tabToMenu?: boolean;
  /** Glass over a white page washes out in the dark theme, so it goes solid. */
  overWhitePage?: boolean;
}) {
  const open = !!selection;

  useEffect(() => {
    if (!open || !tabToMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTyping(event.target) ||
        (event.target as Element | null)?.closest?.(MENU_BUTTON)
      ) {
        return;
      }
      if (focusAskChatButton()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, tabToMenu]);

  // The button unmounts with focus on it, which would drop focus to the page.
  useEffect(() => {
    if (open) return;
    const previous = focusBefore;
    focusBefore = null;
    if (previous && document.activeElement === document.body) {
      previous.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <TranscriptSelectionMenu
      selection={selection}
      onAddToChat={(text) => {
        requestAddToChat(text, "plain");
        onAdded?.();
      }}
      onDismiss={onDismiss}
      surfaceClassName={overWhitePage ? "bg-background-base" : undefined}
    />
  );
}

/**
 * Fork: wraps a view of a file's content and offers "Add to chat" on selected
 * text. `describe` says where the selection came from. The wrapper takes no
 * part in layout. App text is unselectable by default, so it turns that on.
 */
export function AskChatRegion({
  describe,
  enabled = ASK_CHAT_ENABLED,
  overWhitePage = false,
  children,
}: {
  describe: AskChatDescribe;
  enabled?: boolean;
  overWhitePage?: boolean;
  children: ReactNode;
}) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const { selection, dismissSelection } = useAskChatSelection(
    root,
    describe,
    enabled,
  );
  const cells = selection?.cells;
  // What is sent is the rectangle, so that is what gets highlighted, in place
  // of the document-order run a drag across a table selects.
  useEffect(() => {
    if (!cells) return;
    for (const cell of cells) cell.setAttribute(ASK_SELECTED_ATTR, "");
    return () => {
      for (const cell of cells) cell.removeAttribute(ASK_SELECTED_ATTR);
    };
  }, [cells]);
  return (
    <div
      ref={setRoot}
      className={`contents select-text ${cells ? "fork-ask-rectangle" : ""}`}
    >
      {children}
      {enabled ? (
        <AskChatMenu
          selection={selection}
          onDismiss={dismissSelection}
          overWhitePage={overWhitePage}
        />
      ) : null}
    </div>
  );
}
