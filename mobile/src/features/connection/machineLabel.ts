// A copy of the label words in src/fork/machines/machineLabel.ts (phone code
// can't import the desktop's), so both say which computer work is on the
// same way: "Vivobook · Linux" for a machine's host, "Mac" for the desktop.

export type HostInfo = { name: string; platform?: string; osName?: string };

/** "Linux", "macOS" or "Windows"; undefined when unknown. */
export function osLabel(platform: unknown): string | undefined {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return undefined;
  }
}

/** "Vivobook · Linux", or "Vivobook · remote" while the OS is unknown. */
export function machineLabel(name: string | undefined, platform?: unknown): string {
  return `${name?.trim() || "Remote machine"} · ${osLabel(platform) ?? "remote"}`;
}

/**
 * What the phone is connected to. Direct to a machine's host: its machine
 * label. Through the Mac: "Mac", or "desktop" from an older Mac that sends
 * no `host`.
 */
export function connectionLabel(
  direct: boolean,
  host: HostInfo | undefined,
  pairingName?: string,
): string {
  if (direct) {
    return machineLabel(host?.name ?? pairingName, host?.platform);
  }
  if (!host) {
    return "desktop";
  }
  return host.platform === "darwin" ? "Mac" : machineLabel(host.name, host.platform);
}

/**
 * The label for a whole connection's projects: the host's connection label
 * when the phone talks to a machine's host (not the Mac), else undefined.
 */
export function hostProjectsLabel(
  host: HostInfo | undefined,
  label: string,
): string | undefined {
  return host && host.platform !== "darwin" ? label : undefined;
}

/**
 * A project's own machine, when the Mac relays one from a remote machine;
 * otherwise `fallback` (see hostProjectsLabel), so a host's projects still
 * say which computer they are on.
 */
export function projectMachineLabel(
  project: {
    machineName?: string;
    machinePlatform?: string;
  },
  fallback?: string,
): string | undefined {
  return project.machineName
    ? machineLabel(project.machineName, project.machinePlatform)
    : fallback;
}
