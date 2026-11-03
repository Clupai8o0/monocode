import { expect, it } from "vitest";
import { cleanOutput } from "./useTaskOutput";

it("drops colour codes and the trailing blank lines", () => {
  expect(cleanOutput("\x1b[32mok\x1b[0m\nnext\n\n")).toBe("ok\nnext");
});

it("keeps only the last redraw of a progress line", () => {
  expect(cleanOutput("start\n 10%\r 50%\r100%\ndone\n")).toBe(
    "start\n100%\ndone",
  );
});

it("keeps a line that ends in a carriage return", () => {
  expect(cleanOutput("first\r\nsecond\r\n")).toBe("first\nsecond");
});
