import { describe, expect, it } from "vitest";
import { acceptsGzip } from "./compress";

describe("Accept-Encoding", () => {
  it("allows gzip only when the client lists it with a positive weight", () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("br, deflate")).toBe(false);
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("deflate, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("x-gzip")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip ; q=0, *")).toBe(false);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("*;q=0")).toBe(false);
    expect(acceptsGzip(["br", "gzip"])).toBe(true);
  });
});
