import type { LabHealth, LabHealthPoint, LabHealthSession } from "./labProtocol";

/**
 * Fork: Home lab health, the pure part. Which sessions are lagging, whether the
 * machine is strained, and the plain words for both. The numbers come from this
 * machine's own transcripts (31 Oct 2026, 2385 replies over 3 days): replies
 * of 20 s or more never ran under 43 tokens a second. A transcript only gets a
 * reply once it's finished, so a long reply looks silent while it's written:
 * 26 replies took over 90 s, 4 over 180 s, the longest 205 s.
 */

/** Under this, over enough model time, a session is slow. */
export const SLOW_TOKENS_PER_SECOND = 8;
/** Less model time than this in the last minute is too little to judge. */
export const SLOW_MIN_MODEL_SECONDS = 20;
/** Busy, waiting on the model, nothing new: probably just a long reply. */
export const QUIET_MS = 90_000;
/** Longer than almost any real reply: it has stopped answering. */
export const NO_RESPONSE_MS = 180_000;

export const STRAIN_MEMORY_SOME_AVG60 = 10;
export const STRAIN_MEMORY_FULL_AVG10 = 5;
/** The owner's own rule for moving work off the Vivobook. */
export const STRAIN_MEMORY_AVAILABLE_PERCENT = 15;
export const STRAIN_SWAP_CLIMB_MB_PER_MIN = 50;
export const STRAIN_TEMPERATURE_C = 90;

export type SessionLag = "no-response" | "slow" | null;

export function sessionLag(session: LabHealthSession): SessionLag {
  // A tool can rightly take minutes; that isn't the model lagging.
  if (!session.busy || session.waitingOn === "tool") {
    return null;
  }
  const quiet = session.quietMs ?? 0;
  if (quiet >= NO_RESPONSE_MS) {
    return "no-response";
  }
  if (quiet >= QUIET_MS) {
    return "slow";
  }
  if (
    session.tokensPerSecond !== null &&
    session.tokensPerSecond < SLOW_TOKENS_PER_SECOND &&
    session.modelSeconds >= SLOW_MIN_MODEL_SECONDS
  ) {
    return "slow";
  }
  return null;
}

/** Why the machine is strained, one plain phrase each; empty when it's fine. */
export function machineStrain(health: LabHealth): string[] {
  const reasons: string[] = [];
  const memory = health.pressure.memory;
  if (
    memory &&
    (memory.someAvg60 >= STRAIN_MEMORY_SOME_AVG60 || memory.fullAvg10 >= STRAIN_MEMORY_FULL_AVG10)
  ) {
    reasons.push("memory is under pressure");
  }
  if (health.memory.totalMb > 0) {
    const available = (health.memory.availableMb / health.memory.totalMb) * 100;
    if (available < STRAIN_MEMORY_AVAILABLE_PERCENT) {
      reasons.push(`only ${Math.round(available)}% of memory is free`);
    }
  }
  if (health.cpu.load1 > health.cpu.cores) {
    reasons.push(`load is ${formatLoad(health.cpu.load1)} on ${health.cpu.cores} cores`);
  }
  if (health.swap.climbMbPerMin >= STRAIN_SWAP_CLIMB_MB_PER_MIN) {
    reasons.push("swap is climbing");
  }
  if (health.temperatureC !== null && health.temperatureC >= STRAIN_TEMPERATURE_C) {
    reasons.push(`it's running hot at ${health.temperatureC}°C`);
  }
  return reasons;
}

function formatLoad(load: number): string {
  return load >= 10 ? String(Math.round(load)) : load.toFixed(1);
}

/** "4 s", "2 min", "3 h". */
export function shortTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h`;
  }
  return `${Math.round(hours / 24)} days`;
}

/** What a session is doing, for the middle of its row. */
export function sessionActivity(session: LabHealthSession): string {
  if (session.waitingOn === "tool") {
    return "running a tool";
  }
  if (session.tokensPerSecond !== null) {
    return `${Math.round(session.tokensPerSecond)} tok/s`;
  }
  return "waiting";
}

/** "monocode-table · 38 tok/s · 4 s ago" */
export function sessionLine(session: LabHealthSession): string {
  const parts = [session.name, sessionActivity(session)];
  if (session.quietMs !== null) {
    parts.push(`${shortTime(session.quietMs)} ago`);
  }
  return parts.join(" · ");
}

/** "monocode-table: slow, 3 tok/s", for the hover and the chip. */
function lagPhrase(session: LabHealthSession, lag: Exclude<SessionLag, null>): string {
  if (lag === "no-response") {
    return `${session.name}: no response for ${shortTime(session.quietMs ?? 0)}`;
  }
  if ((session.quietMs ?? 0) >= QUIET_MS) {
    return `${session.name}: slow, nothing new for ${shortTime(session.quietMs ?? 0)}`;
  }
  return `${session.name}: slow, ${Math.round(session.tokensPerSecond ?? 0)} tok/s`;
}

/** Lagging first, then busy, longest turn first; idle ones are only counted. */
export function sessionRows(health: LabHealth): {
  rows: { session: LabHealthSession; lag: SessionLag }[];
  idle: number;
} {
  const rank = (lag: SessionLag) => (lag === "no-response" ? 0 : lag === "slow" ? 1 : 2);
  const rows = health.sessions
    .filter((session) => session.busy)
    .map((session) => ({ session, lag: sessionLag(session) }))
    .sort(
      (a, b) =>
        rank(a.lag) - rank(b.lag) ||
        (b.session.turnMs ?? 0) - (a.session.turnMs ?? 0) ||
        a.session.name.localeCompare(b.session.name),
    );
  return { rows, idle: health.sessions.length - rows.length };
}

export type HealthDot = {
  tone: "amber" | "red" | null;
  /** Names the session and the reason; empty when all is well. */
  reason: string;
};

/** One host's dot. */
export function hostDot(health: LabHealth, hostName: string, named: boolean): HealthDot {
  const lagging = sessionRows(health).rows.filter((row) => row.lag !== null);
  const strain = machineStrain(health);
  const parts = lagging.map((row) => `${lagPhrase(row.session, row.lag as Exclude<SessionLag, null>)}.`);
  if (strain.length) {
    parts.push(`${named ? hostName : "The machine"} is strained: ${strain.join(", ")}.`);
  }
  const red = lagging.some((row) => row.lag === "no-response");
  return {
    tone: red ? "red" : parts.length ? "amber" : null,
    reason: parts.join(" "),
  };
}

/** Every host's dot as one: the worst colour, every reason. */
export function combineDots(dots: HealthDot[]): HealthDot {
  const tone = dots.some((dot) => dot.tone === "red")
    ? "red"
    : dots.some((dot) => dot.tone === "amber")
      ? "amber"
      : null;
  return { tone, reason: dots.map((dot) => dot.reason).filter(Boolean).join(" ") };
}

/** The history as columns, oldest first, one per 10 s sample over 10 minutes:
 * null where there's no sample. Heights snap to whole pixel rows. */
export function sparkColumns(
  points: readonly LabHealthPoint[],
  value: (point: LabHealthPoint) => number | null,
  now: number,
  columns = 60,
  rows = 12,
  spanMs = 600_000,
): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: columns }, () => null);
  const step = spanMs / columns;
  for (const point of points) {
    const v = value(point);
    if (v === null) {
      continue;
    }
    const age = now - point.at;
    const slot = columns - 1 - Math.floor(age / step);
    if (slot < 0 || slot >= columns) {
      continue;
    }
    const clamped = Math.min(100, Math.max(0, v));
    // Anything above zero stays visible.
    const height = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * rows)) : 0;
    out[slot] = Math.max(out[slot] ?? 0, height);
  }
  return out;
}

/** "9.6 GB" */
export function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** The machine's small facts on one line. */
export function machineLine(health: LabHealth): string {
  const parts = [`Load ${formatLoad(health.cpu.load1)} on ${health.cpu.cores} cores`];
  if (health.temperatureC !== null) {
    parts.push(`${health.temperatureC}°C`);
  }
  if (health.power.source === "battery") {
    parts.push(
      health.power.batteryPercent !== null ? `On battery ${health.power.batteryPercent}%` : "On battery",
    );
  } else if (health.power.source === "ac") {
    parts.push("Plugged in");
  }
  if (health.swap.totalMb > 0) {
    parts.push(`Swap ${formatGb(health.swap.usedMb)}`);
  }
  return parts.join(" · ");
}

/** "Agents 10 of 10 · 1 waiting · 0.3 GB each" */
export function gateLine(health: LabHealth): string | null {
  const gate = health.gate;
  if (!gate) {
    return null;
  }
  const parts = [`Agents ${gate.running} of ${gate.max}`];
  if (gate.waiting > 0) {
    parts.push(`${gate.waiting} waiting`);
  }
  if (gate.agents.length > 0) {
    const total = gate.agents.reduce((sum, agent) => sum + agent.memoryGb, 0);
    parts.push(`${(total / gate.agents.length).toFixed(1)} GB each`);
  }
  return parts.join(" · ");
}

/** "Round trip 42 ms" */
export function roundTripLine(ms: number | null): string | null {
  return ms === null ? null : `Round trip ${Math.round(ms)} ms`;
}
