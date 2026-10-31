import { describe, expect, it } from "vitest";
import {
  completionWords,
  drillPath,
  finishPythonSource,
  indentFor,
} from "./codeEditorModel";

describe("drill editor setup", () => {
  it("uses a fake path and the language's indent", () => {
    expect(drillPath("javascript")).toBe("drill.js");
    expect(drillPath("python")).toBe("drill.py");
    expect(indentFor("javascript")).toBe("  ");
    expect(indentFor("python")).toBe("    ");
  });
});

describe("completionWords", () => {
  it("offers JavaScript keywords and common built-ins", () => {
    const words = completionWords("javascript", "");
    expect(words).toContain("function");
    expect(words).toContain("Object.keys");
    expect(words).toContain("Math.max");
  });

  it("offers Python keywords and common built-ins", () => {
    const words = completionWords("python", "");
    expect(words).toContain("def");
    expect(words).toContain("enumerate");
    expect(words).toContain("sorted");
  });

  it("adds words already in the document once", () => {
    const words = completionWords("javascript", "const total = total + other;\n");
    expect(words.filter((word) => word === "total")).toHaveLength(1);
    expect(words).toContain("other");
    expect(words.filter((word) => word === "const")).toHaveLength(1);
  });
});

describe("finishPythonSource", () => {
  it("strips trailing spaces and blank lines, then ends with one newline", () => {
    const messy = "def add(a, b):   \n    return a + b  \n\n\n";
    expect(finishPythonSource(messy)).toBe("def add(a, b):\n    return a + b\n");
  });

  it("leaves a single newline for empty code", () => {
    expect(finishPythonSource("")).toBe("\n");
    expect(finishPythonSource("   ")).toBe("\n");
  });
});
