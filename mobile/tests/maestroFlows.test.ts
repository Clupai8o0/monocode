// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FLOWS = fileURLToPath(new URL("./maestro", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function allSource(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return allSource(path);
      return /\.tsx?$/.test(name) ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

const flows = readdirSync(FLOWS).filter((name) => name.endsWith(".yaml"));

/**
 * The device run needs the Mac, so this is what catches a flow drifting from
 * the app here: every literal it taps or expects has to exist in the source.
 */
describe("Maestro flows", () => {
  const source = allSource(SRC);

  it.each(flows)("%s names only text the app has", (name) => {
    const text = readFileSync(join(FLOWS, name), "utf8");
    const literals = [
      ...text.matchAll(
        /(?:tapOn|assertVisible|visible|notVisible):\s*"([^"]+)"/g,
      ),
    ]
      .map((match) => match[1].replace(/ \.\*$/, ""))
      // Values from the runner, like a branch name, aren't the app's text.
      .filter((literal) => !literal.includes("${"));
    for (const literal of literals) {
      expect(source, `${name}: "${literal}"`).toContain(literal);
    }
  });

  it.each(flows)("%s takes its app id from the runner", (name) => {
    expect(readFileSync(join(FLOWS, name), "utf8")).toContain(
      "appId: ${APP_ID}",
    );
  });

  it("runs every flow except the shared step", () => {
    const runner = readFileSync(join(FLOWS, "run.sh"), "utf8");
    const shared = ["open-project.yaml", "go-back.yaml", "close-sheet.yaml"];
    for (const name of flows.filter((flow) => !shared.includes(flow))) {
      expect(runner).toContain(`run_flow ${name}`);
    }
  });
});
