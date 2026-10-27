import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../src/features/providers/model/providerAccounts";

/**
 * The Claude and Codex sign-ins on this machine, found by their config
 * directories: the default one (`~/.claude`, `~/.codex`, or what
 * CLAUDE_CONFIG_DIR / CODEX_HOME name) and any `~/.claude-<name>` or
 * `~/.codex-<name>` beside it that holds a sign-in. A session picks one, and
 * its agent runs with that directory, as the desktop's provider accounts do.
 *
 * Only names and emails leave this module; credentials are never read here
 * beyond checking that they exist, and never copied.
 */

export type AccountProvider = "claude" | "codex";

export type HostAccount = {
  id: string;
  provider: AccountProvider;
  label: string;
  dir: string;
  isDefault: boolean;
  /**
   * Another folder signed in as an account already listed. Left out of the
   * picker, but still found by its id, so sessions started with it keep
   * working whichever copy was refreshed last.
   */
  duplicate?: boolean;
};

/** How long a scan stands; signing in elsewhere shows up after this. */
const FRESH_MS = 30_000;

const SIGN_IN: Record<AccountProvider, string> = {
  claude: ".credentials.json",
  codex: "auth.json",
};

const json = (path: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const modified = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/** The email a directory is signed in as, when it says. */
function email(
  provider: AccountProvider,
  dir: string,
  home: string,
  isDefault: boolean,
): string | null {
  if (provider === "claude") {
    // Claude keeps its account beside the default directory, not in it.
    const config = json(
      isDefault && resolve(dir) === resolve(home, ".claude")
        ? join(home, ".claude.json")
        : join(dir, ".claude.json"),
    );
    const account = config?.oauthAccount as Record<string, unknown> | undefined;
    return typeof account?.emailAddress === "string" ? account.emailAddress : null;
  }
  // Codex: the ID token's claims, which carry the email.
  const tokens = json(join(dir, "auth.json"))?.tokens as
    | Record<string, unknown>
    | undefined;
  const token = typeof tokens?.id_token === "string" ? tokens.id_token : "";
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export function scanAccounts(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): HostAccount[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    // No home to look in: only the defaults.
  }
  const found: HostAccount[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const defaultDir = resolve(
      (provider === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME) ||
        join(home, `.${provider}`),
    );
    const defaultEmail = email(provider, defaultDir, home, true);
    found.push({
      id: DEFAULT_PROVIDER_ACCOUNT_ID,
      provider,
      label: defaultEmail ?? "Default account",
      dir: defaultDir,
      isDefault: true,
    });
    // Named ones, newest sign-in first, so of two copies of one account the
    // one in use is the one listed.
    const named = entries
      .filter((entry) => entry.startsWith(`.${provider}-`))
      .map((entry) => {
        const dir = join(home, entry);
        return { dir, at: modified(join(dir, SIGN_IN[provider])) };
      })
      .filter(
        (entry): entry is { dir: string; at: number } =>
          entry.at !== null && resolve(entry.dir) !== defaultDir,
      )
      .sort((a, b) => b.at - a.at);
    // A default with no sign-in left can't stand in for a named one.
    const emails = new Set(
      defaultEmail && modified(join(defaultDir, SIGN_IN[provider])) !== null
        ? [defaultEmail]
        : [],
    );
    for (const { dir } of named) {
      const name = basename(dir).slice(provider.length + 2);
      // "default" names the default folder, never another one.
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || name === DEFAULT_PROVIDER_ACCOUNT_ID)
        continue;
      const address = email(provider, dir, home, false);
      const duplicate = !!address && emails.has(address);
      if (address) emails.add(address);
      found.push({
        id: name,
        provider,
        label: address ? `${address} (${name})` : name,
        dir,
        isDefault: false,
        ...(duplicate ? { duplicate } : {}),
      });
    }
  }
  return found;
}

let cache: { at: number; key: string; accounts: HostAccount[] } | null = null;

/** This machine's accounts, duplicates included, rescanned at most every half minute. */
export function hostAccounts(): HostAccount[] {
  const key = [homedir(), process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME].join("\n");
  if (!cache || cache.key !== key || Date.now() - cache.at > FRESH_MS)
    cache = { at: Date.now(), key, accounts: scanAccounts() };
  return cache.accounts;
}

/** The account a session or probe names, or undefined if there is none. */
export function hostAccount(
  provider: unknown,
  id: unknown,
): HostAccount | undefined {
  const wanted = typeof id === "string" && id ? id : DEFAULT_PROVIDER_ACCOUNT_ID;
  return hostAccounts().find(
    (account) => account.provider === provider && account.id === wanted,
  );
}

/** The environment an agent runs with to use `account`, as the desktop sets it. */
export function accountEnv(
  account: HostAccount,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (account.isDefault) return env;
  const next = { ...env };
  if (account.provider === "claude") {
    next.CLAUDE_CONFIG_DIR = account.dir;
    next.CLAUDE_SECURESTORAGE_CONFIG_DIR = account.dir;
    delete next.ANTHROPIC_API_KEY;
    delete next.ANTHROPIC_AUTH_TOKEN;
    delete next.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    next.CODEX_HOME = account.dir;
    delete next.OPENAI_API_KEY;
    delete next.CODEX_API_KEY;
    delete next.CODEX_ACCESS_TOKEN;
  }
  return next;
}
