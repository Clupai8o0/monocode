// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const SWIFT_VIEWS = /from "@expo\/ui\/swift-ui"/;
const ANDROID_GUARD = /Platform\.OS === "android"|Platform\.OS === "ios"/;

/**
 * SwiftUI views have no Android implementation: rendering one shuts React
 * down, and the crash then repeats on every launch. A file that uses them
 * needs an `.android.tsx` twin, or a Platform check before it draws one.
 */
describe("SwiftUI views stay off Android", () => {
  // A `.ios` file never loads on Android, so it's free to use them.
  const files = sources(SRC).filter(
    (path) => !path.includes(".android.") && !path.includes(".ios."),
  );
  const users = files.filter((path) =>
    SWIFT_VIEWS.test(readFileSync(path, "utf8")),
  );

  it("finds the files it is guarding", () => {
    expect(users.length).toBeGreaterThan(3);
  });

  it.each(users.map((path) => [relative(SRC, path), path]))(
    "%s has an Android path",
    (_name, path) => {
      const twin = path.replace(/\.tsx$/, ".android.tsx");
      if (existsSync(twin)) return;
      const text = readFileSync(path, "utf8");
      expect(text).toMatch(ANDROID_GUARD);
      // The guard has to come before the first SwiftUI view it protects.
      const firstHost = text.indexOf("<Host");
      const guard = text.search(ANDROID_GUARD);
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(firstHost);
    },
  );
});

describe("the phone's own identity", () => {
  const config = JSON.parse(
    readFileSync(new URL("../app.json", import.meta.url), "utf8"),
  ).expo;

  it("signs on iOS under the owner's id, not upstream's", () => {
    expect(config.ios.bundleIdentifier).toBe("com.clupai.monocode");
  });

  it("keeps the Android package, so the installed app updates in place", () => {
    expect(config.android.package).toBe("com.hardbeat920.monocodemobile");
  });

  it("takes no updates from upstream's Expo project", () => {
    expect(config.updates.enabled).toBe(false);
    expect(JSON.stringify(config)).not.toContain("u.expo.dev");
    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas?.projectId).toBeUndefined();
  });

  it("asks for no push entitlement, which a free Apple ID can't sign", () => {
    const plugin = readFileSync(
      new URL("../plugins/with-local-notifications.js", import.meta.url),
      "utf8",
    );
    expect(plugin).toContain('delete config.modResults["aps-environment"]');
  });
});
