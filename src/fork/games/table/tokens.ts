/** Fork: play-money tokens and how you stand against each agent. Never real money. */

const TOKENS_KEY = "monocode.fork.games.tokens";
const RIVALS_KEY = "monocode.fork.games.rivals";

export const START_TOKENS = 10_000;
export const BUMP_TOKENS = 5_000;

export type Bankroll = { tokens: number; peak: number };
export type Rival = { net: number; wins: number; losses: number; draws: number };
export type Rivals = Record<string, Rival>;

function read<T>(key: string, parse: (value: unknown) => T | null, fallback: T) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = parse(JSON.parse(raw));
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // Unreadable or blocked: start over, it's only play money.
  }
  return fallback;
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store just forgets.
  }
}

function parseBankroll(value: unknown): Bankroll | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { tokens, peak } = value as Partial<Bankroll>;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    return null;
  }
  const floored = Math.floor(tokens);
  return {
    tokens: floored,
    peak: typeof peak === "number" && peak >= floored ? Math.floor(peak) : floored,
  };
}

function parseRivals(value: unknown): Rivals | null {
  return value && typeof value === "object" ? (value as Rivals) : null;
}

/**
 * The card games share one balance, so only one may have chips in play at a
 * time; otherwise the same tokens could be bet twice.
 */
let tableInPlay: string | null = null;

export const chipsInPlay = {
  /** Claims the balance for a game. False if the other game has it. */
  claim(game: string) {
    if (tableInPlay && tableInPlay !== game) {
      return false;
    }
    tableInPlay = game;
    return true;
  },
  release(game: string) {
    if (tableInPlay === game) {
      tableInPlay = null;
    }
  },
};

let bankroll: Bankroll | null = null;
let rivals: Rivals | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) {
    listener();
  }
}

function currentBankroll() {
  bankroll ??= read(TOKENS_KEY, parseBankroll, {
    tokens: START_TOKENS,
    peak: START_TOKENS,
  });
  return bankroll;
}

function currentRivals() {
  rivals ??= read(RIVALS_KEY, parseRivals, {});
  return rivals;
}

export const tokenStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  bankroll: currentBankroll,
  rivals: currentRivals,
  /** Moves tokens in or out. The balance can't go below nothing. */
  add(delta: number) {
    if (!delta) {
      return;
    }
    const before = currentBankroll();
    const tokens = Math.max(0, Math.floor(before.tokens + delta));
    bankroll = { tokens, peak: Math.max(before.peak, tokens) };
    write(TOKENS_KEY, bankroll);
    changed();
  },
  addRival(id: string, change: Partial<Rival>) {
    const all = currentRivals();
    const rival = all[id] ?? { net: 0, wins: 0, losses: 0, draws: 0 };
    rivals = {
      ...all,
      [id]: {
        net: rival.net + (change.net ?? 0),
        wins: rival.wins + (change.wins ?? 0),
        losses: rival.losses + (change.losses ?? 0),
        draws: rival.draws + (change.draws ?? 0),
      },
    };
    write(RIVALS_KEY, rivals);
    changed();
  },
};

/** 950, 12.4k, 3k. */
export function formatTokens(value: number) {
  const size = Math.abs(value);
  if (size < 1000) {
    return String(Math.round(value));
  }
  const thousands = (Math.round(size / 100) / 10).toString();
  return `${value < 0 ? "-" : ""}${thousands}k`;
}

export function rivalLine(name: string, net: number) {
  if (net === 0) {
    return `even with ${name}`;
  }
  return net > 0
    ? `you're up ${formatTokens(net)} on ${name}`
    : `you're down ${formatTokens(-net)} to ${name}`;
}

/**
 * Who your result for a hand came from, or went to. If you won, the losers paid
 * in proportion to what they lost; if you lost, the winners took it the same way.
 */
export function rivalShares(mine: number, others: Record<string, number>) {
  const shares: Record<string, number> = {};
  if (mine === 0) {
    return shares;
  }
  const side = Object.entries(others).filter(([, net]) =>
    mine > 0 ? net < 0 : net > 0,
  );
  const total = side.reduce((sum, [, net]) => sum + Math.abs(net), 0);
  if (total === 0) {
    return shares;
  }
  for (const [id, net] of side) {
    shares[id] = Math.round((mine * Math.abs(net)) / total);
  }
  return shares;
}
