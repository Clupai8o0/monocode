import { execChild } from "../../core/child";
import { parseClaudeVersion } from "./claudeProtocol";

/** CLI version per binary path, read once per app run. */
const versionByPath = new Map<string, Promise<string | null>>();

/** The Claude Code version at `path`, or null when it can't be read. */
export function claudeVersionAt(path: string): Promise<string | null> {
  let version = versionByPath.get(path);
  if (!version) {
    version = (async () => {
      try {
        return parseClaudeVersion(
          await execChild(path, ["--version"], undefined, "claude"),
        );
      } catch {
        return null;
      }
    })();
    versionByPath.set(path, version);
  }
  return version;
}
