import { X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import type { RemoteDesktopStatus } from "../src/fork/lab/labProtocol";
import { parseShow, type CommandRunner } from "./lab-system";

export const RDP_PORT = 3389;
const UNIT = "monocode-krdp.service";
/** KDE's own unit for krdpserver; it listens on every network. */
const KDE_UNIT = "app-org.kde.krdpserver.service";
const PORTAL = [
  "org.freedesktop.impl.portal.PermissionStore",
  "/org/freedesktop/impl/portal/PermissionStore",
  "org.freedesktop.impl.portal.PermissionStore",
];

export type KrdpOptions = {
  run: CommandRunner;
  home?: string;
  username?: string;
  hostname?: string;
  krdpserver?: string;
  exists?: (path: string) => boolean;
  /** The tailscale0 interface's IPv4, when the CLI is missing. */
  tailscaleInterface?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
};

/** The first IPv4 address of `tailscale ip -4`. */
export function parseTailscaleIp(stdout: string): string | null {
  const first = stdout.split("\n")[0]?.trim() ?? "";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(first) ? first : null;
}

/** The local addresses listening on a port, from `ss -ltnH`. */
export function listeners(stdout: string, port: number): string[] {
  const hosts: string[] = [];
  for (const line of stdout.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    if (Number(local.slice(at + 1)) !== port) continue;
    hosts.push(local.slice(0, at).replace(/%.*$/, ""));
  }
  return hosts;
}

/** Whether something listens on the port beyond Tailscale and loopback. */
export function exposedBeyond(
  hosts: string[],
  tailscale: string | null,
): boolean {
  return hosts.some((host) => {
    const bare = host.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
    if (bare === tailscale) return false;
    if (bare.startsWith("127.") || bare === "::1") return false;
    // Tailscale's own IPv6 range.
    if (bare.toLowerCase().startsWith("fd7a:115c:a1e0:")) return false;
    return true;
  });
}

/** Lookup's answer says krdpserver may share the screen without a click. */
export function parsePermission(stdout: string): boolean {
  return /"org\.kde\.krdpserver" \d+(?: "[^"]*")*? "yes"/.test(stdout);
}

export function rdpFile(address: string, username: string): string {
  return [
    `full address:s:${address}:${RDP_PORT}`,
    `username:s:${username}`,
    "prompt for credentials:i:1",
    "authentication level:i:2",
    "screen mode id:i:2",
    "",
  ].join("\r\n");
}

export function rdpUri(address: string, username: string): string {
  return `rdp://full%20address=s:${address}:${RDP_PORT}&username=s:${encodeURIComponent(username)}`;
}

/** The SHA-256 fingerprint of a PEM certificate's DER bytes, lowercase hex. */
export function fingerprint(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
  } catch {
    return null;
  }
}

/**
 * KDE's RDP server on a Linux machine, bound to the Tailscale address only,
 * signing in with the Linux user's own password.
 */
export class KrdpControl {
  private readonly home: string;
  private readonly username: string;
  private readonly binary: string;
  private readonly exists: (path: string) => boolean;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: KrdpOptions) {
    this.home = options.home ?? homedir();
    this.username = options.username ?? userInfo().username;
    this.binary = options.krdpserver ?? "/usr/bin/krdpserver";
    this.exists = options.exists ?? existsSync;
    this.wait =
      options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  get certDir(): string {
    return join(this.home, ".local/share/monocode-host/krdp");
  }

  installed(): boolean {
    return this.exists(this.binary);
  }

  async status(): Promise<RemoteDesktopStatus | null> {
    if (!this.installed()) return null;
    const [units, address, ss, systemUser, preauthorized, sha256] =
      await Promise.all([
        this.units(),
        this.address(),
        this.ss(),
        this.systemUser(),
        this.preauthorized(),
        this.certificate(),
      ]);
    const via = units.monocode ? "monocode" : units.kde ? "kde" : null;
    return {
      installed: true,
      running: via !== null,
      via,
      lanExposed: exposedBeyond(listeners(ss, RDP_PORT), address),
      address,
      port: RDP_PORT,
      username: this.username,
      certificate: { present: sha256 !== null, sha256 },
      systemUser,
      preauthorized,
      rdpFile: address ? rdpFile(address, this.username) : null,
      uri: address ? rdpUri(address, this.username) : null,
    };
  }

  async set(enabled: boolean): Promise<void> {
    if (!this.installed()) throw new Error("Remote desktop is not installed");
    if (!enabled) {
      await this.stop([UNIT, KDE_UNIT]);
      return;
    }
    const address = await this.address();
    if (!address) throw new Error("Tailscale is not up");
    const { crt, key } = await this.ensureCertificate();
    await this.must(
      "kwriteconfig6",
      [
        "--file",
        "krdpserverrc",
        "--group",
        "General",
        "--key",
        "SystemUserEnabled",
        "true",
      ],
      "Could not turn on password sign-in",
    );
    await this.must(
      "busctl",
      [
        "--user",
        "call",
        ...PORTAL,
        "SetPermission",
        "sbssas",
        "kde-authorized",
        "true",
        "remote-desktop",
        "org.kde.krdpserver",
        "1",
        "yes",
      ],
      "Could not allow screen sharing",
    );
    const units = await this.units();
    if (units.kde) await this.stop([KDE_UNIT]);
    if (units.monocode) {
      if (listeners(await this.ss(), RDP_PORT).includes(address)) return;
      await this.stop([UNIT]);
    }
    await this.must(
      "systemd-run",
      [
        "--user",
        `--unit=${UNIT.replace(/\.service$/, "")}`,
        "--collect",
        "--quiet",
        "--property=Restart=on-failure",
        this.binary,
        "--address",
        address,
        "--port",
        String(RDP_PORT),
        "--certificate",
        crt,
        "--certificate-key",
        key,
      ],
      "Could not start remote desktop",
    );
    for (let waited = 0; waited < 5000; waited += 250) {
      if (listeners(await this.ss(), RDP_PORT).includes(address)) return;
      await this.wait(250);
    }
    throw new Error("Remote desktop did not start");
  }

  async address(): Promise<string | null> {
    const result = await this.options.run("tailscale", ["ip", "-4"], {
      timeoutMs: 5000,
    });
    const ip = result.code === 0 ? parseTailscaleIp(result.stdout) : null;
    return ip ?? (this.options.tailscaleInterface ?? tailscaleInterface)();
  }

  private async units(): Promise<{ monocode: boolean; kde: boolean }> {
    const result = await this.options.run(
      "systemctl",
      ["--user", "show", UNIT, KDE_UNIT, "-p", "Id,ActiveState"],
      { timeoutMs: 5000 },
    );
    const active = new Set(
      parseShow(result.stdout)
        .filter((unit) =>
          ["active", "activating", "reloading"].includes(
            unit.ActiveState ?? "",
          ),
        )
        .map((unit) => unit.Id),
    );
    return { monocode: active.has(UNIT), kde: active.has(KDE_UNIT) };
  }

  private async ss(): Promise<string> {
    const result = await this.options.run("ss", ["-ltnH"], { timeoutMs: 5000 });
    return result.code === 0 ? result.stdout : "";
  }

  private async systemUser(): Promise<boolean> {
    const result = await this.options.run(
      "kreadconfig6",
      [
        "--file",
        "krdpserverrc",
        "--group",
        "General",
        "--key",
        "SystemUserEnabled",
      ],
      { timeoutMs: 5000 },
    );
    return result.code === 0 && result.stdout.trim() === "true";
  }

  private async preauthorized(): Promise<boolean> {
    const result = await this.options.run(
      "busctl",
      [
        "--user",
        "call",
        ...PORTAL,
        "Lookup",
        "ss",
        "kde-authorized",
        "remote-desktop",
      ],
      { timeoutMs: 5000 },
    );
    return result.code === 0 && parsePermission(result.stdout);
  }

  private async certificate(): Promise<string | null> {
    try {
      const crt = join(this.certDir, "krdp.crt");
      if (!this.exists(join(this.certDir, "krdp.key"))) return null;
      return fingerprint(await readFile(crt, "utf8"));
    } catch {
      return null;
    }
  }

  /** Makes the certificate once: dir 0700, key 0600. */
  private async ensureCertificate(): Promise<{ crt: string; key: string }> {
    const crt = join(this.certDir, "krdp.crt");
    const key = join(this.certDir, "krdp.key");
    await mkdir(this.certDir, { recursive: true, mode: 0o700 });
    await chmod(this.certDir, 0o700);
    const have = await Promise.all(
      [crt, key].map((path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!have.every(Boolean)) {
      await this.must(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "3650",
          "-subj",
          `/CN=${this.options.hostname ?? hostname()}`,
          "-keyout",
          key,
          "-out",
          crt,
        ],
        "Could not make a certificate",
        30_000,
      );
    }
    await chmod(key, 0o600);
    return { crt, key };
  }

  private async stop(units: string[]): Promise<void> {
    // A unit that is not loaded is already off.
    for (const unit of units) {
      const result = await this.options.run(
        "systemctl",
        ["--user", "stop", unit],
        { timeoutMs: 20_000 },
      );
      if (result.code !== 0 && !/not loaded/i.test(result.stderr)) {
        throw new Error("Could not stop remote desktop");
      }
    }
  }

  private async must(
    command: string,
    args: string[],
    failure: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const result = await this.options.run(command, args, { timeoutMs });
    if (result.code !== 0) throw new Error(failure);
  }
}

function tailscaleInterface(): string | null {
  const entries = networkInterfaces().tailscale0 ?? [];
  return entries.find((entry) => entry.family === "IPv4")?.address ?? null;
}
