import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { accountEnv, scanAccounts } from "./accounts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "monocode-accounts-test-"));
  homes.push(dir);
  return dir;
}

function claude(dir: string, email: string | null, age = 0) {
  mkdirSync(dir, { recursive: true });
  const credentials = join(dir, ".credentials.json");
  writeFileSync(credentials, "{}");
  const when = new Date(Date.now() - age);
  utimesSync(credentials, when, when);
  if (email)
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    );
}

it("finds the default and named sign-ins, once per email", () => {
  const root = home();
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", ".credentials.json"), "{}");
  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }),
  );
  claude(join(root, ".claude-exec"), "work@example.com");
  // An older copy of the same sign-in, and one of the default's.
  claude(join(root, ".claude-cx"), "work@example.com", 60_000);
  claude(join(root, ".claude-old"), "main@example.com", 60_000);
  // No sign-in: not an account.
  mkdirSync(join(root, ".claude-empty"));
  mkdirSync(join(root, ".codex"));
  const claims = Buffer.from(JSON.stringify({ email: "codex@example.com" })).toString(
    "base64url",
  );
  writeFileSync(
    join(root, ".codex", "auth.json"),
    JSON.stringify({ tokens: { id_token: `x.${claims}.y` } }),
  );

  // Reserved: never lets a folder stand in for the default.
  claude(join(root, ".claude-default"), "other@example.com");

  const all = scanAccounts(root, {});
  // Copies stay reachable by id for the sessions that use them.
  expect(
    all.filter((account) => account.duplicate).map((account) => account.id).sort(),
  ).toEqual(["cx", "old"]);
  const accounts = all.filter((account) => !account.duplicate);
  expect(accounts.map(({ provider, id, label, isDefault }) => ({
    provider,
    id,
    label,
    isDefault,
  }))).toEqual([
    { provider: "claude", id: "default", label: "main@example.com", isDefault: true },
    {
      provider: "claude",
      id: "exec",
      label: "work@example.com (exec)",
      isDefault: false,
    },
    { provider: "codex", id: "default", label: "codex@example.com", isDefault: true },
  ]);
});

it("lists a named sign-in when the default with its email has signed out", () => {
  const root = home();
  mkdirSync(join(root, ".claude"));
  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }),
  );
  claude(join(root, ".claude-main"), "main@example.com");
  const named = scanAccounts(root, {}).find((account) => account.id === "main");
  expect(named?.duplicate).toBeUndefined();
});

it("takes the default from CLAUDE_CONFIG_DIR, and never lists it twice", () => {
  const root = home();
  claude(join(root, ".claude-exec"), "work@example.com");
  const accounts = scanAccounts(root, {
    CLAUDE_CONFIG_DIR: join(root, ".claude-exec"),
  }).filter((account) => account.provider === "claude");
  expect(accounts).toEqual([
    expect.objectContaining({
      id: "default",
      label: "work@example.com",
      dir: join(root, ".claude-exec"),
    }),
  ]);
});

it("points an agent at a named account's directory and drops API keys", () => {
  const env = { ANTHROPIC_API_KEY: "key", PATH: "/bin" };
  const named = {
    id: "exec",
    provider: "claude" as const,
    label: "exec",
    dir: "/home/u/.claude-exec",
    isDefault: false,
  };
  expect(accountEnv(named, env)).toEqual({
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/home/u/.claude-exec",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/u/.claude-exec",
  });
  expect(accountEnv({ ...named, isDefault: true }, env)).toBe(env);
  expect(
    accountEnv({ ...named, provider: "codex", dir: "/c" }, { OPENAI_API_KEY: "k" }),
  ).toEqual({ CODEX_HOME: "/c" });
});
