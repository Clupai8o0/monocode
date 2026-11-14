import { describe, expect, it } from "vitest";
import { claudeFileDelivery } from "./claudeDelivery";
import { resolveWorkspaceFileReference } from "../../../../shared/lib/paths";

describe("claudeFileDelivery", () => {
  it("preserves home and Windows paths with literal line suffixes", () => {
    expect(claudeFileDelivery("SendUserFile", { files: ["~/out/report:12"] }, "/Users/me/repo"))
      .toBe("[report:12](<~/out/report%3A12>)");
    expect(claudeFileDelivery("SendUserFile", { files: ["C:\\tmp\\a.html"] }, "C:/repo"))
      .toBe("[a.html](<C%3A/tmp/a.html>)");
    expect(resolveWorkspaceFileReference("/tmp/report%3A12", "/repo"))
      .toEqual({ path: "/tmp/report:12" });
  });
  it("resolves relative paths and a single file, and escapes line suffixes", () => {
    expect(claudeFileDelivery("SendUserFile", { files: "preview/report:12" }, "/repo"))
      .toBe("[report:12](</repo/preview/report%3A12>)");
  });
  it("omits per-file upload failures even when is_error is absent", () => {
    expect(claudeFileDelivery("SendUserFile", { files: ["/tmp/good.html", "/tmp/bad.html"] }, "/repo", {
      attachments: [{ path: "/tmp/good.html" }, { path: "/tmp/bad.html", upload_error: "unreadable" }],
    })).toBe("[good.html](</tmp/good.html>)");
    expect(claudeFileDelivery("SendUserFile", { files: ["/tmp/bad.html"] }, "/repo", undefined, "1 file could NOT be delivered to the user")).toBeUndefined();
  });
  it("shows every delivered file with escaped filenames", () => {
    expect(
      claudeFileDelivery("SendUserFile", {
        files: ["/tmp/a[b].html", "/tmp/question?#.png"],
        caption: "Preview",
      }),
    ).toBe(
      "Preview\n\n[a\\[b\\].html](</tmp/a%5Bb%5D.html>)\n\n[question?#.png](</tmp/question%3F%23.png>)",
    );
  });

  it("ignores other tools, URLs and malformed file inputs", () => {
    expect(claudeFileDelivery("Read", { files: ["/tmp/a"] })).toBeUndefined();
    for (const files of [
      undefined,
      "file",
      [null, 1, {}, "relative", "https://example.com", "/tmp/a\nb", "/"],
    ]) {
      expect(claudeFileDelivery("SendUserFile", { files })).toBeUndefined();
    }
  });
});
