import { describe, expect, it } from "vitest";
import { fitScale, formatSize, svgSize } from "./svgModel";

describe("svgSize", () => {
  it("uses width and height when both are set", () => {
    expect(
      svgSize('<svg width="24" height="16px" viewBox="0 0 48 48"></svg>'),
    ).toEqual({ width: 24, height: 16 });
  });

  it("falls back to the viewBox, with commas or spaces", () => {
    expect(svgSize('<svg viewBox="0,0,120,80"/>')).toEqual({
      width: 120,
      height: 80,
    });
  });

  it("keeps the viewBox ratio when only one side is set", () => {
    expect(svgSize('<svg width="50" viewBox="0 0 100 40"/>')).toEqual({
      width: 50,
      height: 20,
    });
    expect(svgSize("<svg height='10' viewBox='0 0 100 40'/>")).toEqual({
      width: 25,
      height: 10,
    });
  });

  it("ignores relative units, comments and the XML declaration", () => {
    expect(
      svgSize(
        '<?xml version="1.0"?><!-- <svg width="1" height="1"> --><svg width="100%" height="2em" viewBox="0 0 10 20"/>',
      ),
    ).toEqual({ width: 10, height: 20 });
  });

  it("does not match attributes that only end in width", () => {
    expect(svgSize('<svg stroke-width="3" viewBox="0 0 8 8"/>')).toEqual({
      width: 8,
      height: 8,
    });
  });

  it("returns null when the file gives no size", () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeNull();
    expect(svgSize("not svg")).toBeNull();
    expect(svgSize('<svg viewBox="0 0 0 10"/>')).toBeNull();
  });
});

describe("fitScale", () => {
  it("fits inside the box minus padding, up or down", () => {
    expect(
      fitScale({ width: 10, height: 10 }, { width: 120, height: 220 }, 10),
    ).toBe(10);
    expect(
      fitScale({ width: 1000, height: 500 }, { width: 520, height: 520 }, 10),
    ).toBe(0.5);
  });
});

describe("formatSize", () => {
  it("rounds to two decimals", () => {
    expect(formatSize({ width: 24, height: 33.3333 })).toBe("24 × 33.33");
  });
});
