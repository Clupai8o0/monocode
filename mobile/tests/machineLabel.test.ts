import { describe, expect, it } from "vitest";

import {
  connectionLabel,
  machineLabel,
  hostProjectsLabel,
  osLabel,
  projectMachineLabel,
} from "@/features/connection/machineLabel";

describe("machine labels", () => {
  it("names the OS", () => {
    expect(osLabel("linux")).toBe("Linux");
    expect(osLabel("darwin")).toBe("macOS");
    expect(osLabel("win32")).toBe("Windows");
    expect(osLabel("aix")).toBeUndefined();
  });
  it("labels a machine", () => {
    expect(machineLabel("Vivobook", "linux")).toBe("Vivobook · Linux");
    expect(machineLabel("Vivobook")).toBe("Vivobook · remote");
    expect(machineLabel(" ")).toBe("Remote machine · remote");
  });
  it("labels the connection", () => {
    expect(connectionLabel(true, { name: "Vivobook", platform: "linux" })).toBe(
      "Vivobook · Linux",
    );
    expect(connectionLabel(true, undefined, "fedora")).toBe("fedora · remote");
    expect(connectionLabel(false, { name: "mac", platform: "darwin" })).toBe("Mac");
    expect(connectionLabel(false, undefined, "Sam's Mac")).toBe("desktop");
  });
  it("labels a relayed project", () => {
    expect(
      projectMachineLabel({ machineName: "Vivobook", machinePlatform: "linux" }),
    ).toBe("Vivobook · Linux");
    expect(projectMachineLabel({})).toBeUndefined();
  });
  it("labels a host's own projects with the connection label", () => {
    const host = { name: "Vivobook", platform: "linux" };
    const label = connectionLabel(true, host);
    const fallback = hostProjectsLabel(host, label);
    expect(projectMachineLabel({}, fallback)).toBe("Vivobook · Linux");
    expect(
      projectMachineLabel({ machineName: "Pi", machinePlatform: "linux" }, fallback),
    ).toBe("Pi · Linux");
    const mac = { name: "Mac", platform: "darwin" };
    expect(hostProjectsLabel(mac, connectionLabel(false, mac))).toBeUndefined();
    expect(hostProjectsLabel(undefined, "desktop")).toBeUndefined();
    expect(projectMachineLabel({}, undefined)).toBeUndefined();
  });
});
