import { describe, expect, it } from "vitest";
import {
  acknowledgeQuoteRequest,
  appendSelectionQuote,
  composerSeedForAddToChat,
  consumeQuoteRequest,
  isMarkdownBlockquotePosition,
  type QuoteRequest,
} from "./quoteDraft";

describe("appendSelectionQuote", () => {
  it("formats a multiline selection and leaves room for a reply", () => {
    expect(appendSelectionQuote("", " line one\r\nline two ")).toBe(
      "> line one\n> line two\n\n",
    );
  });

  it("preserves intentional blank lines inside a quote", () => {
    expect(appendSelectionQuote("", "one\n\ntwo")).toBe("> one\n>\n> two\n\n");
  });

  it.each([
    ["draft", "draft\n\n> quote\n\n"],
    ["draft\n", "draft\n\n> quote\n\n"],
    ["draft\n\n", "draft\n\n> quote\n\n"],
  ])("separates an existing draft %#", (draft, expected) => {
    expect(appendSelectionQuote(draft, "quote")).toBe(expected);
  });

  it("ignores whitespace-only selections", () => {
    expect(appendSelectionQuote("draft", "  \n ")).toBe("draft");
  });
});

describe("composerSeedForAddToChat", () => {
  it("preserves the requested insertion mode for a new composer", () => {
    expect(composerSeedForAddToChat("selected")).toBe("> selected\n\n");
    expect(composerSeedForAddToChat("Comment", "plain")).toBe("Comment\n\n");
  });
});

describe("isMarkdownBlockquotePosition", () => {
  it("recognizes tokens after nested quote markers", () => {
    const text = "plain /one\n> /two\n  >> @file";
    expect(isMarkdownBlockquotePosition(text, text.indexOf("/one"))).toBe(
      false,
    );
    expect(isMarkdownBlockquotePosition(text, text.indexOf("/two"))).toBe(true);
    expect(isMarkdownBlockquotePosition(text, text.indexOf("@file"))).toBe(
      true,
    );
  });
});

describe("consumeQuoteRequest", () => {
  const request: QuoteRequest = { id: 1, text: "selected" };

  it("consumes a request once", () => {
    expect(consumeQuoteRequest("draft", null, request)).toEqual({
      draft: "draft\n\n> selected\n\n",
      consumedId: 1,
      changed: true,
    });
    expect(consumeQuoteRequest("draft", 1, request)).toEqual({
      draft: "draft",
      consumedId: 1,
      changed: false,
    });
  });

  it("accepts a new id even when the text is identical", () => {
    expect(
      consumeQuoteRequest("", 1, { id: 2, text: "selected" }),
    ).toMatchObject({ consumedId: 2, changed: true });
  });

  it("inserts plain text without quoting", () => {
    expect(
      consumeQuoteRequest("draft", null, {
        id: 3,
        text: "Note: Auth\n\nUse a cookie.",
        mode: "plain",
      }),
    ).toEqual({
      draft: "draft\n\nNote: Auth\n\nUse a cookie.\n\n",
      consumedId: 3,
      changed: true,
    });
  });
});

describe("picked options in the draft", () => {
  const consume = (draft: string, text: string, mode: "line" | "removeLine") =>
    consumeQuoteRequest(draft, null, { id: 1, text, mode }).draft;

  it("adds each option on its own line", () => {
    const one = consume("", "Apply", "line");
    expect(one).toBe("Apply\n");
    expect(consume(one, "Hold", "line")).toBe("Apply\nHold\n");
    expect(consume("my note", "Apply", "line")).toBe("my note\nApply\n");
  });

  it("takes back only that option, leaving what was typed", () => {
    expect(consume("Apply\nHold\n", "Apply", "removeLine")).toBe("Hold\n");
    expect(consume("my note\nApply\n", "Apply", "removeLine")).toBe(
      "my note\n",
    );
    expect(consume("Apply\n", "Apply", "removeLine")).toBe("");
    expect(consume("Apply\nmy note\nApply\n", "Apply", "removeLine")).toBe(
      "Apply\nmy note\n",
    );
    expect(consume("I typed this", "Apply", "removeLine")).toBe("I typed this");
  });

  it("opens no new chat just to take an option back", () => {
    expect(composerSeedForAddToChat("Apply", "removeLine")).toBe("");
    expect(composerSeedForAddToChat("Apply", "line")).toBe("Apply\n");
  });
});

describe("acknowledgeQuoteRequest", () => {
  it("clears only the request that was acknowledged", () => {
    const current: QuoteRequest = { id: 2, text: "newer" };
    expect(acknowledgeQuoteRequest(current, 2)).toBeUndefined();
    expect(acknowledgeQuoteRequest(current, 1)).toBe(current);
  });
});
