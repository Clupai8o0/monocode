import { invoke } from "@tauri-apps/api/core";

/** Fork: a live emulator or simulator beside a session. */
export type Device = { id: string; kind: "ios" | "android"; name: string };

export const listDevices = () => invoke<Device[]>("fork_device_list");
export const deviceScreenshot = (device: string) =>
  invoke<string>("fork_device_screenshot", { device });
export const deviceTap = (device: string, x: number, y: number) =>
  invoke<void>("fork_device_tap", { device, x, y });
export const deviceSwipe = (
  device: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
) =>
  invoke<void>("fork_device_swipe", {
    device,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
  });
export const deviceType = (device: string, text: string) =>
  invoke<void>("fork_device_type", { device, text });

export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };

/** A point on the shown image, in the device's own pixels. */
export function devicePoint(
  clientX: number,
  clientY: number,
  box: Box,
  natural: Size,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: x * natural.width, y: y * natural.height };
}

/** Below this, in screen pixels on the panel, a press is a tap and not a drag. */
const DRAG_THRESHOLD = 8;

export function isSwipe(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD;
}

/** One device panel, opened from the Stacks panel. */
let openKind: Device["kind"] | null = null;
const listeners = new Set<() => void>();

export function openDevicePanel(kind: Device["kind"] | null) {
  openKind = kind;
  listeners.forEach((listener) => listener());
}

export const devicePanelKind = () => openKind;

export function subscribeDevicePanel(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The device to show: the kind that was asked for, else the first running. */
export function pickDevice(
  devices: readonly Device[],
  kind: Device["kind"] | null,
  current: string | null,
): Device | null {
  return (
    devices.find((device) => device.id === current) ??
    devices.find((device) => device.kind === kind) ??
    devices[0] ??
    null
  );
}
