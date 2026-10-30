export const ADD_TO_CHAT_EVENT = "monocode:add-to-chat";

/** `line` and `removeLine` add or take back one line, for a picked option. */
export type AddToChatMode = "quote" | "plain" | "line" | "removeLine";

export type AddToChatRequest = {
  text: string;
  mode: AddToChatMode;
};

export type QuoteRequest = {
  id: number;
  text: string;
  mode?: AddToChatMode;
};

export function requestAddToChat(text: string, mode: AddToChatMode = "quote") {
  if (typeof window === "undefined") return;
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (!value) return;
  window.dispatchEvent(
    new CustomEvent<AddToChatRequest>(ADD_TO_CHAT_EVENT, {
      detail: { text: value, mode },
    }),
  );
}

/** Initial composer text for an add-to-chat request that opens a new session. */
export function composerSeedForAddToChat(
  text: string,
  mode: AddToChatMode = "quote",
): string {
  return applyInsert("", text, mode);
}

export type QuoteConsumption = {
  draft: string;
  consumedId: number | null;
  changed: boolean;
};

export function isMarkdownBlockquotePosition(
  text: string,
  position: number,
): boolean {
  const index = Math.max(0, Math.min(position, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  return /^ {0,3}>/.test(text.slice(lineStart, index));
}

export function appendSelectionQuote(draft: string, text: string): string {
  const selected = text.replace(/\r\n?/g, "\n").trim();
  if (!selected) return draft;

  const quote = selected
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return joinComposerInsert(draft, quote);
}

export function appendComposerInsert(draft: string, text: string): string {
  const selected = text.replace(/\r\n?/g, "\n").trim();
  if (!selected) return draft;
  return joinComposerInsert(draft, selected);
}

export function appendComposerLine(draft: string, text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return draft;
  const separator = draft.length === 0 || draft.endsWith("\n") ? "" : "\n";
  return `${draft}${separator}${line}\n`;
}

/**
 * Takes back the last such line, since options go in at the end; a draft left
 * with nothing else in it empties.
 */
export function removeComposerLine(draft: string, text: string): string {
  const lines = draft.split("\n");
  const index = lines.lastIndexOf(text.replace(/\s+/g, " ").trim());
  if (index < 0) return draft;
  lines.splice(index, 1);
  const next = lines.join("\n");
  return next.trim() ? next : "";
}

function applyInsert(
  draft: string,
  text: string,
  mode: AddToChatMode = "quote",
): string {
  switch (mode) {
    case "plain":
      return appendComposerInsert(draft, text);
    case "line":
      return appendComposerLine(draft, text);
    case "removeLine":
      return removeComposerLine(draft, text);
    case "quote":
      return appendSelectionQuote(draft, text);
  }
}

export function consumeQuoteRequest(
  draft: string,
  consumedId: number | null,
  request: QuoteRequest | undefined,
): QuoteConsumption {
  if (!request || request.id === consumedId) {
    return { draft, consumedId, changed: false };
  }

  const next = applyInsert(draft, request.text, request.mode);
  return {
    draft: next,
    consumedId: request.id,
    changed: next !== draft,
  };
}

export function acknowledgeQuoteRequest(
  current: QuoteRequest | undefined,
  handledId: number,
): QuoteRequest | undefined {
  return current?.id === handledId ? undefined : current;
}

function joinComposerInsert(draft: string, block: string): string {
  const separator =
    draft.length === 0
      ? ""
      : draft.endsWith("\n\n")
        ? ""
        : draft.endsWith("\n")
          ? "\n"
          : "\n\n";
  return `${draft}${separator}${block}\n\n`;
}
