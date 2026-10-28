import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRunner } from "./lab-fake";
import {
  exposedBeyond,
  fingerprint,
  KrdpControl,
  listeners,
  parsePermission,
  parseTailscaleIp,
  rdpFile,
  rdpUri,
} from "./lab-krdp";

// Trimmed from the vivobook, 28 Oct 2026.
const SS = `LISTEN 0      4096                100.113.240.52:52861 0.0.0.0:*
LISTEN 0      4096                 127.0.0.53%lo:53    0.0.0.0:*
LISTEN 0      4096                       0.0.0.0:5355  0.0.0.0:*
LISTEN 0      4096   [fd7a:115c:a1e0::7e34:f035]:45504    [::]:*
LISTEN 0      511                              *:3501        *:*
`;
const IP = "100.113.240.52";
const ON_TAILSCALE = `${SS}LISTEN 0      50      ${IP}:3389  0.0.0.0:*\n`;
const ON_LAN = `${SS}LISTEN 0      50                               *:3389        *:*\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-krdp-test-"));
  dirs.push(dir);
  return dir;
}

describe("krdp parsers", () => {
  it("reads tailscale, ss and the portal", () => {
    expect(parseTailscaleIp(`${IP}\n`)).toBe(IP);
    expect(parseTailscaleIp("")).toBeNull();
    expect(listeners(ON_TAILSCALE, 3389)).toEqual([IP]);
    expect(listeners(SS, 3389)).toEqual([]);
    expect(exposedBeyond(listeners(ON_TAILSCALE, 3389), IP)).toBe(false);
    expect(exposedBeyond(listeners(ON_LAN, 3389), IP)).toBe(true);
    expect(exposedBeyond(["0.0.0.0"], null)).toBe(true);
    expect(exposedBeyond(["127.0.0.1", "[::1]"], IP)).toBe(false);
    expect(
      parsePermission('a{sas}v 1 "org.kde.krdpserver" 1 "yes" b false'),
    ).toBe(true);
    expect(
      parsePermission('a{sas}v 1 "org.kde.krdpserver" 1 "no" b false'),
    ).toBe(false);
    expect(parsePermission("")).toBe(false);
  });

  it("builds the .rdp file and the link", () => {
    expect(rdpFile(IP, "clupai")).toBe(
      `full address:s:${IP}:3389\r\nusername:s:clupai\r\nprompt for credentials:i:1\r\nauthentication level:i:2\r\nscreen mode id:i:2\r\n`,
    );
    expect(rdpUri(IP, "clupai")).toBe(
      `rdp://full%20address=s:${IP}:3389&username=s:clupai`,
    );
  });
});

describe("remote desktop", () => {
  it("is null when krdpserver is missing", async () => {
    const control = new KrdpControl({
      run: fakeRunner({}).run,
      exists: () => false,
    });
    expect(await control.status()).toBeNull();
    await expect(control.set(true)).rejects.toThrow(
      "Remote desktop is not installed",
    );
  });

  it("reports KDE's own unit as exposed to the network", async () => {
    const { run } = fakeRunner({
      "systemctl --user show": {
        stdout:
          "Id=monocode-krdp.service\nActiveState=inactive\n\nId=app-org.kde.krdpserver.service\nActiveState=active\n",
      },
      "tailscale ip -4": { stdout: `${IP}\n` },
      "ss -ltnH": { stdout: ON_LAN },
      kreadconfig6: { stdout: "\n" },
      "busctl --user call": {
        code: 1,
        stderr: "Call failed: No entry for remote-desktop",
      },
    });
    const dir = home();
    const status = await new KrdpControl({
      run,
      home: dir,
      username: "clupai",
      exists: (path) => path === "/usr/bin/krdpserver",
    }).status();
    expect(status).toMatchObject({
      installed: true,
      running: true,
      via: "kde",
      lanExposed: true,
      address: IP,
      port: 3389,
      username: "clupai",
      certificate: { present: false, sha256: null },
      systemUser: false,
      preauthorized: false,
      uri: `rdp://full%20address=s:${IP}:3389&username=s:clupai`,
    });
  });

  it("refuses to turn on without Tailscale", async () => {
    const { run } = fakeRunner({ "tailscale ip -4": { code: 1 } });
    const control = new KrdpControl({
      run,
      home: home(),
      exists: () => true,
      tailscaleInterface: () => null,
    });
    await expect(control.set(true)).rejects.toThrow("Tailscale is not up");
    expect((await control.status())?.rdpFile).toBeNull();
  });

  it("turns on bound to Tailscale, stopping KDE's unit first", async () => {
    const dir = home();
    const certDir = join(dir, ".local/share/monocode-host/krdp");
    let started = false;
    const { run, calls } = fakeRunner({
      "systemctl --user show": () => ({
        stdout: `Id=monocode-krdp.service\nActiveState=${started ? "active" : "inactive"}\n\nId=app-org.kde.krdpserver.service\nActiveState=active\n`,
      }),
      "systemctl --user stop": {},
      "systemctl --user stop monocode-krdp.service": {
        code: 5,
        stderr:
          "Failed to stop monocode-krdp.service: Unit monocode-krdp.service not loaded.",
      },
      "tailscale ip -4": { stdout: `${IP}\n` },
      "ss -ltnH": () => ({ stdout: started ? ON_TAILSCALE : SS }),
      kwriteconfig6: {},
      "busctl --user call": {},
      openssl: (args) => {
        // Stand in for openssl: write a real self-signed pair.
        mkdirSync(certDir, { recursive: true });
        const key = args[args.indexOf("-keyout") + 1]!;
        const crt = args[args.indexOf("-out") + 1]!;
        execFileSync("openssl", args, { stdio: "ignore" });
        statSync(key);
        statSync(crt);
        return {};
      },
      "systemd-run": () => {
        started = true;
        return {};
      },
    });
    const control = new KrdpControl({
      run,
      home: dir,
      username: "clupai",
      hostname: "clupai",
      exists: (path) => path === "/usr/bin/krdpserver" || statSafe(path),
      sleep: async () => {},
    });
    await control.set(true);
    const crt = join(certDir, "krdp.crt");
    const key = join(certDir, "krdp.key");
    const order = calls.filter((call) => !/show|ss -ltnH|tailscale/.test(call));
    expect(order[0]).toMatch(
      /^openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj \/CN=clupai /,
    );
    expect(order.slice(1)).toEqual([
      "kwriteconfig6 --file krdpserverrc --group General --key SystemUserEnabled true",
      "busctl --user call org.freedesktop.impl.portal.PermissionStore /org/freedesktop/impl/portal/PermissionStore org.freedesktop.impl.portal.PermissionStore SetPermission sbssas kde-authorized true remote-desktop org.kde.krdpserver 1 yes",
      "systemctl --user stop app-org.kde.krdpserver.service",
      `systemd-run --user --unit=monocode-krdp --collect --quiet --property=Restart=on-failure /usr/bin/krdpserver --address ${IP} --port 3389 --certificate ${crt} --certificate-key ${key}`,
    ]);
    expect(statSync(certDir).mode & 0o777).toBe(0o700);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const status = await control.status();
    expect(status?.certificate.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(status).toMatchObject({ via: "monocode", lanExposed: false });

    calls.length = 0;
    await control.set(false);
    expect(calls).toEqual([
      "systemctl --user stop monocode-krdp.service",
      "systemctl --user stop app-org.kde.krdpserver.service",
    ]);
  });

  it("fails plainly when the port never opens", async () => {
    const dir = home();
    const certDir = join(dir, ".local/share/monocode-host/krdp");
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, "krdp.crt"), "x");
    writeFileSync(join(certDir, "krdp.key"), "x");
    const { run } = fakeRunner({
      "systemctl --user show": { stdout: "" },
      "tailscale ip -4": { stdout: `${IP}\n` },
      "ss -ltnH": { stdout: SS },
      kwriteconfig6: {},
      "busctl --user call": {},
      "systemd-run": {},
    });
    const control = new KrdpControl({
      run,
      home: dir,
      exists: () => true,
      sleep: async () => {},
    });
    await expect(control.set(true)).rejects.toThrow(
      "Remote desktop did not start",
    );
  });

  it("fails when a stop really fails", async () => {
    const { run } = fakeRunner({
      "systemctl --user stop": { code: 1, stderr: "Access denied" },
    });
    const control = new KrdpControl({ run, exists: () => true });
    await expect(control.set(false)).rejects.toThrow(
      "Could not stop remote desktop",
    );
  });

  it("takes the certificate's SHA-256 over its DER bytes", () => {
    expect(fingerprint("not a cert")).toBeNull();
  });
});

function statSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
