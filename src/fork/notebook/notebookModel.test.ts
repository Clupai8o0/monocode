import { describe, expect, it } from "vitest";
import {
  fenced,
  isNotebookPath,
  parseNotebook,
  stripAnsi,
} from "./notebookModel";

const NOTEBOOK = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { language: "python", name: "python3" },
    language_info: { name: "Python" },
  },
  cells: [
    {
      cell_type: "markdown",
      source: ["# Title\n", "![plot](attachment:a.png)"],
      attachments: { "a.png": { "image/png": "iVBOR\nw0=" } },
    },
    {
      cell_type: "code",
      execution_count: 3,
      source: "print('hi')\n1/0",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hi\n"] },
        { output_type: "stream", name: "stderr", text: "warn\n" },
        {
          output_type: "execute_result",
          data: {
            "text/html": "<script>alert(1)</script>",
            "text/plain": ["   a\n", "0  1"],
          },
        },
        { output_type: "display_data", data: { "image/png": "AAAA\n" } },
        { output_type: "display_data", data: { "image/svg+xml": ["<svg/>"] } },
        {
          output_type: "display_data",
          data: { "application/vnd.jupyter.widget-view+json": {} },
        },
        {
          output_type: "error",
          ename: "ZeroDivisionError",
          evalue: "division by zero",
          traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m", "line 2"],
        },
        { output_type: "unknown" },
      ],
    },
    { cell_type: "code", execution_count: null, source: [], outputs: [] },
    { cell_type: "raw", source: "raw text" },
  ],
};

describe("parseNotebook", () => {
  const notebook = parseNotebook(JSON.stringify(NOTEBOOK));

  it("reads the language and every cell", () => {
    expect(notebook.language).toBe("python");
    expect(notebook.cells.map((cell) => cell.kind)).toEqual([
      "markdown",
      "code",
      "code",
      "raw",
    ]);
    expect(notebook.cells[1].source).toBe("print('hi')\n1/0");
    expect(notebook.cells[1].executionCount).toBe(3);
    expect(notebook.cells[2].executionCount).toBeNull();
  });

  it("inlines pasted image attachments in markdown", () => {
    expect(notebook.cells[0].source).toBe(
      "# Title\n![plot](data:image/png;base64,iVBORw0=)",
    );
  });

  it("shows plain text instead of HTML, and never keeps script", () => {
    const outputs = notebook.cells[1].outputs;
    expect(outputs).toEqual([
      { kind: "text", text: "hi\n", stream: "stdout" },
      { kind: "text", text: "warn\n", stream: "stderr" },
      { kind: "text", text: "   a\n0  1" },
      { kind: "image", mime: "image/png", src: "data:image/png;base64,AAAA" },
      { kind: "svg", source: "<svg/>" },
      {
        kind: "hidden",
        mimes: ["application/vnd.jupyter.widget-view+json"],
      },
      {
        kind: "error",
        name: "ZeroDivisionError",
        text: "ZeroDivisionError\nline 2",
      },
    ]);
    expect(JSON.stringify(outputs)).not.toContain("<script>");
  });

  it("explains files it can't show", () => {
    expect(() => parseNotebook("{")).toThrow(/not valid JSON/);
    expect(() => parseNotebook("[]")).toThrow(/not valid JSON/);
    expect(() =>
      parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [] })),
    ).toThrow(/too old/);
    expect(() => parseNotebook(JSON.stringify({ nbformat: 4 }))).toThrow(
      /no cells/,
    );
  });

  it("defaults the language to python", () => {
    expect(parseNotebook('{"nbformat":4,"cells":[]}').language).toBe("python");
  });
});

describe("helpers", () => {
  it("routes .ipynb files", () => {
    expect(isNotebookPath("/w/Analysis.IPYNB")).toBe(true);
    expect(isNotebookPath("/w/a.ipynb.json")).toBe(false);
  });

  it("strips colour codes", () => {
    expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
  });

  it("fences code so backticks inside cannot close it", () => {
    expect(fenced("x = 1", "python")).toBe("```python\nx = 1\n```");
    expect(fenced("s = '````'", "python")).toBe(
      "`````python\ns = '````'\n`````",
    );
  });
});
