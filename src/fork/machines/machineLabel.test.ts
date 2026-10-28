import { describe, expect, it } from "vitest";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import {
  describeToInfo,
  localMachineLabel,
  machineDetail,
  machineLabel,
  osLabel,
  whereOf,
} from "./machineLabel";
import { parseShowItem, showableUrl } from "../shows/showsModel";

const vivobook: RemoteMachine = {
  id: "m-1",
  name: "Vivobook",
  endpoint: "http://100.113.240.52:4510",
  environmentId: "env-1",
};

describe("machine labels", () => {
  it("names the OS, or says remote until it is known", () => {
    expect(osLabel("linux")).toBe("Linux");
    expect(osLabel("darwin")).toBe("macOS");
    expect(osLabel("win32")).toBe("Windows");
    expect(osLabel("aix")).toBeUndefined();
    expect(machineLabel("Vivobook", "linux")).toBe("Vivobook · Linux");
    expect(machineLabel("Vivobook")).toBe("Vivobook · remote");
    expect(machineLabel("  ", "linux")).toBe("Remote machine · Linux");
    expect(localMachineLabel(true)).toBe("This Mac");
    expect(localMachineLabel(false)).toBe("This computer");
  });

  it("reads a describe answer and the settings line", () => {
    const info = describeToInfo(
      {
        name: "fedora",
        platform: "linux",
        osName: "Fedora Linux 44",
        capabilities: ["sessions", "shows"],
      },
      5,
    );
    expect(info).toEqual({
      platform: "linux",
      osName: "Fedora Linux 44",
      hostname: "fedora",
      shows: true,
      checkedAt: 5,
    });
    expect(machineDetail(info, "Vivobook")).toBe("Linux · Fedora Linux 44 · host: fedora");
    expect(machineDetail({ ...info, hostname: "vivobook" }, "Vivobook")).toBe(
      "Linux · Fedora Linux 44",
    );
    expect(describeToInfo({ platform: "beos" }, 1)).toEqual({
      platform: undefined,
      osName: undefined,
      hostname: undefined,
      shows: false,
      checkedAt: 1,
    });
  });

  it("tells a remote path from a local one", () => {
    const info = describeToInfo({ platform: "linux" }, 1);
    expect(whereOf("remote://env-1/home/sam/x", [vivobook], () => info, true)).toMatchObject({
      remote: true,
      label: "Vivobook · Linux",
      name: "Vivobook",
    });
    expect(whereOf("remote://env-2/home/sam/x", [vivobook], () => info, true)).toMatchObject({
      remote: true,
      label: "Another machine · remote",
    });
    expect(whereOf("/Users/sam/x", [vivobook], () => info, true)).toEqual({
      remote: false,
      label: "This Mac",
      show: true,
    });
    expect(whereOf("/Users/sam/x", [], () => info, true)).toMatchObject({ show: false });
  });
});

describe("show items", () => {
  const file = {
    id: "abc_DEF-1",
    seq: 3,
    kind: "file",
    name: "report.pdf",
    size: 10,
    createdAt: 1,
  };

  it("keeps good items and drops bad ones", () => {
    expect(parseShowItem(file)).toMatchObject({ id: "abc_DEF-1", name: "report.pdf", size: 10 });
    expect(parseShowItem({ ...file, id: "../x" })).toBeUndefined();
    expect(parseShowItem({ ...file, size: 30 * 1024 * 1024 })).toBeUndefined();
    expect(parseShowItem({ ...file, seq: 0 })).toBeUndefined();
    expect(
      parseShowItem({ ...file, kind: "url", url: "https://example.com/a", size: undefined }),
    ).toMatchObject({ url: "https://example.com/a" });
    expect(parseShowItem({ ...file, kind: "url", url: "file:///etc/passwd" })).toBeUndefined();
  });

  it("allows only http and https links", () => {
    expect(showableUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(showableUrl("javascript:alert(1)")).toBeUndefined();
    expect(showableUrl("ftp://x")).toBeUndefined();
    expect(showableUrl("not a url")).toBeUndefined();
  });
});
