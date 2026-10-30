import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  findLargeInsert,
  LARGE_PASTE_BYTES,
  pasteAttachment,
  pasteFileName,
  pasteFirstLine,
  toBase64,
} from "@/features/sessions/largePaste";

const big = "x".repeat(LARGE_PASTE_BYTES);

describe("findLargeInsert", () => {
  it("ignores typing and small pastes", () => {
    expect(findLargeInsert("hello", "hello!")).toBeNull();
    expect(findLargeInsert("", "x".repeat(LARGE_PASTE_BYTES - 1))).toBeNull();
  });

  it("takes a big paste out and keeps what was already there", () => {
    expect(findLargeInsert("before after", `before ${big}after`)).toEqual({
      inserted: big,
      remaining: "before after",
      at: 7,
    });
  });

  it("handles a paste into an empty field and at either end", () => {
    expect(findLargeInsert("", big)?.remaining).toBe("");
    expect(findLargeInsert("end", `${big}end`)?.remaining).toBe("end");
    expect(findLargeInsert("start", `start${big}`)?.remaining).toBe("start");
  });

  it("isn't fooled when the paste repeats the text around it", () => {
    const found = findLargeInsert("xx", `x${big}x`);
    expect(found?.remaining).toBe("xx");
    expect(found?.inserted.length).toBe(big.length);
  });

  it("counts bytes, not characters", () => {
    const wide = "語".repeat(Math.ceil(LARGE_PASTE_BYTES / 3));
    expect(findLargeInsert("", wide)?.inserted).toBe(wide);
  });

  it("catches a paste replacing a selection just as long", () => {
    const old = "y".repeat(LARGE_PASTE_BYTES);
    expect(findLargeInsert(`a${old}b`, `a${big}b`)).toEqual({
      inserted: big,
      remaining: "ab",
      at: 1,
    });
  });

  it("ignores deleting text", () => {
    expect(findLargeInsert(big, "")).toBeNull();
  });
});

describe("toBase64", () => {
  it.each(["", "a", "ab", "abc", "abcd", "日本語 and emoji 🙂"])("matches Node for %j", (text) => {
    const bytes = new TextEncoder().encode(text);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("the attachment", () => {
  it("carries the exact text as a named text file", () => {
    const attachment = pasteAttachment("id", "Error: boom\nmore");
    expect(attachment.name).toBe("pasted-error-boom.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.size).toBe(16);
    expect(Buffer.from(attachment.data, "base64").toString()).toBe("Error: boom\nmore");
  });

  it("names and previews plainly", () => {
    expect(pasteFileName("日本語")).toBe("pasted-text.txt");
    expect(pasteFirstLine("\n  hi \nthere")).toBe("hi");
    expect(pasteFirstLine("a".repeat(200)).endsWith("…")).toBe(true);
  });
});
