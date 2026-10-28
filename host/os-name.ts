import { readFileSync } from "node:fs";

let cached: { value: string | undefined } | undefined;

/** A readable OS name, e.g. "Fedora Linux 44" or "macOS 26.1"; read once. */
export function hostOsName(): string | undefined {
  if (!cached) {
    cached = { value: readOsName() };
  }
  return cached.value;
}

export function parseOsRelease(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith("PRETTY_NAME="));
  if (!line) {
    return undefined;
  }
  const value = line.slice("PRETTY_NAME=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value ? value.slice(0, 120) : undefined;
}

function readOsName(): string | undefined {
  try {
    if (process.platform === "linux") {
      for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
        try {
          return parseOsRelease(readFileSync(path, "utf8"));
        } catch {
          /* try the next one */
        }
      }
      return undefined;
    }
    if (process.platform === "darwin") {
      const plist = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8");
      const version = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      return version ? `macOS ${version.trim()}` : undefined;
    }
  } catch {
    /* leave it out */
  }
  return undefined;
}
