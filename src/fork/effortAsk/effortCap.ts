/**
 * Fork feature: MonoCode keeps a session's effort as low as its task allows.
 *
 * - A new session never inherits more than High from the last picked effort.
 *   The model's effort line raises it the moment a task needs more
 *   (effortAsk.ts), so starting at High costs one short turn on a hard task,
 *   while starting at Extra High or Max costs every turn of every simple one.
 * - Switches the model asks for stop at Extra High. Max stays a manual pick.
 *
 * Measured 1 Nov 2026: main sessions at Max cost $725 a week, and 468 replies
 * at Max said High was enough (vault 30-resources/token-savings-2026-11.md).
 */

const RANK = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
];

/** Other names providers use for a level. */
const ALIASES: Record<string, string> = { "extra-high": "xhigh" };

/** The most a new session starts on. */
export const NEW_SESSION_EFFORT_CAP = "high";

/** The most the model's effort line switches a session to. */
export const AUTO_EFFORT_CAP = "xhigh";

/** Off under the test runner, so upstream tests see the stored effort. */
const FORK_EFFORT_CAP = import.meta.env.MODE !== "test";

function rankOf(value: string | undefined): number {
  const name = value?.toLowerCase();
  return name ? RANK.indexOf(ALIASES[name] ?? name) : -1;
}

/**
 * The stored last-used settings with the effort held to High, or to the
 * session's own effort when that is higher: switching the model of a session
 * on Max never raises it past where it was, nor drops it below High.
 */
export function cappedStartSettings(
  stored: Record<string, string>,
  settingId: string | undefined,
  current?: Record<string, string>,
  enabled = FORK_EFFORT_CAP,
): Record<string, string> {
  if (!enabled || !settingId) {
    return stored;
  }
  const rank = rankOf(stored[settingId]);
  const cap = Math.max(
    rankOf(NEW_SESSION_EFFORT_CAP),
    rankOf(current?.[settingId]),
  );
  if (rank <= cap) {
    return stored;
  }
  return { ...stored, [settingId]: RANK[cap]! };
}

/**
 * The option a switch the model asked for lands on, held to Extra High: the
 * highest option at or under the cap (or under the session's own level, when
 * the user put it higher), so a model without Extra High is not rounded up to
 * Max. Null when that leaves nothing to switch to.
 */
export function cappedAutoOption(
  options: readonly { value: string }[],
  chosen: string,
  current?: string,
): string | null {
  const want = rankOf(chosen);
  const now = rankOf(current);
  const cap = rankOf(AUTO_EFFORT_CAP);
  if (want <= cap || now >= want) {
    return chosen;
  }
  const limit = Math.max(cap, now);
  const under = options
    .filter((option) => {
      const rank = rankOf(option.value);
      return rank >= 0 && rank <= limit;
    })
    .sort((a, b) => rankOf(b.value) - rankOf(a.value));
  return under[0]?.value ?? null;
}
