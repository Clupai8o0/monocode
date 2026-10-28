import { describe, expect, it } from "vitest";
import { ntfySubscribeLink } from "@/features/settings/ntfyLink";

describe("ntfy subscribe link", () => {
  it.each([
    [
      "https://clupai-vivobook.tail4b2925.ts.net:8443",
      "ntfy://clupai-vivobook.tail4b2925.ts.net:8443/monocode-abc",
    ],
    ["https://ntfy.example/", "ntfy://ntfy.example/monocode-abc"],
    ["https://ntfy.example:443", "ntfy://ntfy.example/monocode-abc"],
    ["http://10.0.0.2:2586", "ntfy://10.0.0.2:2586/monocode-abc?secure=false"],
  ])("subscribes to %s", (server, link) => {
    expect(ntfySubscribeLink({ server, topic: "monocode-abc" })).toBe(link);
  });

  it("refuses an address that is not http(s)", () => {
    expect(ntfySubscribeLink({ server: "ftp://x", topic: "t" })).toBeNull();
    expect(ntfySubscribeLink({ server: "nope", topic: "t" })).toBeNull();
  });
});
