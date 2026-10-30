import { describe, expect, it } from "vitest";
import { devicePoint, isSwipe, pickDevice, type Device } from "./deviceModel";

const box = { left: 100, top: 50, width: 200, height: 400 };
const natural = { width: 1080, height: 2340 };

describe("devicePoint", () => {
  it("scales a click to the device's own pixels", () => {
    expect(devicePoint(200, 250, box, natural)).toEqual({ x: 540, y: 1170 });
    expect(devicePoint(100, 50, box, natural)).toEqual({ x: 0, y: 0 });
    expect(devicePoint(300, 450, box, natural)).toEqual({ x: 1080, y: 2340 });
  });

  it("ignores a point off the screen or before the image has a size", () => {
    expect(devicePoint(99, 250, box, natural)).toBeNull();
    expect(devicePoint(200, 451, box, natural)).toBeNull();
    expect(devicePoint(200, 250, { ...box, width: 0 }, natural)).toBeNull();
  });
});

describe("isSwipe", () => {
  it("tells a tap from a drag", () => {
    expect(isSwipe({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(isSwipe({ x: 0, y: 0 }, { x: 0, y: 40 })).toBe(true);
  });
});

describe("pickDevice", () => {
  const ios: Device = { id: "ios:1", kind: "ios", name: "iPhone" };
  const android: Device = { id: "android:emulator-1", kind: "android", name: "Pixel" };

  it("stays on the shown device while it's running", () => {
    expect(pickDevice([ios, android], "ios", android.id)).toBe(android);
  });

  it("moves to the asked kind, then anything running", () => {
    expect(pickDevice([ios, android], "android", null)).toBe(android);
    expect(pickDevice([ios], "android", "gone")).toBe(ios);
    expect(pickDevice([], "ios", null)).toBeNull();
  });
});
