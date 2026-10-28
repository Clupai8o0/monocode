import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("names the device a token belongs to, and no one once it is revoked", () => {
  const dir = mkdtempSync(join(tmpdir(), "monocode-store-device-"));
  dirs.push(dir);
  const store = new HostStore(join(dir, "host.sqlite"));
  try {
    const phone = store.issueDevice("Phone");
    const laptop = store.issueDevice("Laptop");
    expect(store.device(phone.token)).toEqual({ id: phone.id, name: "Phone" });
    expect(store.device(laptop.token)).toEqual({ id: laptop.id, name: "Laptop" });
    expect(store.device("not a token")).toBeNull();
    store.revokeToken(phone.token);
    expect(store.device(phone.token)).toBeNull();
  } finally {
    store.close();
  }
});
