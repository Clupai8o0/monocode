// @vitest-environment happy-dom
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRemoteControlStore,
  remoteControlActive,
  remoteControlChoice,
  remoteControlEnded,
  remoteControlState,
  remoteControlWanted,
  setRemoteControlState,
  setRemoteControlWanted,
} from "./remoteControlStore";

// Node 22+ shadows happy-dom's localStorage with a disabled built-in getter.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new Window().localStorage,
});

const WANTED_KEY = "monocode.fork.remoteControl.sessions";

beforeEach(() => {
  __resetRemoteControlStore();
  localStorage.clear();
});

describe("the wanted set", () => {
  it("persists to localStorage and is re-read after a reset", () => {
    setRemoteControlWanted("session-a", true);
    setRemoteControlWanted("session-b", true);
    expect(JSON.parse(localStorage.getItem(WANTED_KEY) ?? "[]")).toEqual([
      "session-a",
      "session-b",
    ]);

    __resetRemoteControlStore();
    expect(remoteControlWanted("session-a")).toBe(true);
    expect(remoteControlWanted("session-b")).toBe(true);
  });

  it("forgets a session when it is turned off", () => {
    setRemoteControlWanted("session-a", true);
    setRemoteControlWanted("session-a", false);
    expect(JSON.parse(localStorage.getItem(WANTED_KEY) ?? "[]")).toEqual([]);
    __resetRemoteControlStore();
    expect(remoteControlWanted("session-a")).toBe(false);
  });
});

describe("remoteControlState", () => {
  it("is waiting when wanted with no live state, and off otherwise", () => {
    expect(remoteControlState("session-a")).toEqual({ status: "off" });
    setRemoteControlWanted("session-a", true);
    expect(remoteControlState("session-a")).toEqual({ status: "waiting" });
    expect(remoteControlState("session-b")).toEqual({ status: "off" });
  });

  it("keeps a live state until it ends, then falls back to waiting", () => {
    setRemoteControlWanted("session-a", true);
    setRemoteControlState("session-a", {
      status: "on",
      url: "https://claude.ai/code/session_x",
    });
    expect(remoteControlState("session-a")).toEqual({
      status: "on",
      url: "https://claude.ai/code/session_x",
    });

    remoteControlEnded("session-a");
    expect(remoteControlState("session-a")).toEqual({ status: "waiting" });
  });

  it("falls back to off when the session was not wanted", () => {
    setRemoteControlState("session-a", { status: "starting" });
    remoteControlEnded("session-a");
    expect(remoteControlState("session-a")).toEqual({ status: "off" });
  });

  it("off clears the live state", () => {
    setRemoteControlState("session-a", {
      status: "failed",
      error: "Claude could not start Remote Control",
    });
    setRemoteControlState("session-a", { status: "off" });
    expect(remoteControlState("session-a")).toEqual({ status: "off" });
  });
});

describe("remoteControlActive", () => {
  it("is true while on, starting or still stopping", () => {
    setRemoteControlState("session-a", { status: "starting" });
    expect(remoteControlActive("session-a")).toBe(true);

    setRemoteControlState("session-a", { status: "on" });
    expect(remoteControlActive("session-a")).toBe(true);

    setRemoteControlState("session-a", { status: "stopping" });
    expect(remoteControlActive("session-a")).toBe(true);

    setRemoteControlState("session-a", { status: "waiting" });
    expect(remoteControlActive("session-a")).toBe(false);

    setRemoteControlState("session-a", {
      status: "failed",
      error: "Claude could not start Remote Control",
    });
    expect(remoteControlActive("session-a")).toBe(false);

    setRemoteControlState("session-a", { status: "off" });
    expect(remoteControlActive("session-a")).toBe(false);
  });
});

describe("remoteControlChoice", () => {
  it("remembers on, off and no choice, across a reload", () => {
    expect(remoteControlChoice("session-c")).toBeUndefined();
    setRemoteControlWanted("session-c", false);
    expect(remoteControlChoice("session-c")).toBe(false);
    __resetRemoteControlStore();
    expect(remoteControlChoice("session-c")).toBe(false);
    setRemoteControlWanted("session-c", true);
    expect(remoteControlChoice("session-c")).toBe(true);
    __resetRemoteControlStore();
    expect(remoteControlChoice("session-c")).toBe(true);
  });
});
