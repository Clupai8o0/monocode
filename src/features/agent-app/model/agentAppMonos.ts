import type { AgentAppHost } from "./agentApp";
import { isLocalProject, sameProjectPath } from "../../projects/model/recents";
import { createMono, findMono, listMonos, monoLook, updateMono, type Mono } from "../../monos/model/mono";
import { withMonoConfigurationLock } from "../../monos/model/monoConfigurationLock";
import { HABITS_MAX, habitSchedule, habitScheduleLabel, newHabit, nextHabitRunAt, type Habit } from "../../monos/model/monoHabits";
import { RUNTIME_MODES, type RuntimeMode, type Session } from "../../sessions/model/session";

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be non-empty text (at most ${max} characters)`);
  }
  return value.trim();
};

function exclusiveProject(mono: Mono, cwd: string): boolean {
  return mono.projects.length === 1 && sameProjectPath(mono.projects[0], cwd);
}

function scopedMono(id: string, cwd: string): Mono {
  const mono = findMono(id);
  if (!mono || !exclusiveProject(mono, cwd)) {
    throw new Error("That Mono is not exclusive to this project; use monos.list for available Monos");
  }
  return mono;
}

export function habitInput(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("habit must be an object");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !["id", "name", "instructions", "schedule", "enabled"].includes(key));
  if (unknown.length) throw new Error(`Unknown habit fields: ${unknown.join(", ")}`);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("habit.enabled must be true or false");
  }
  return {
    ...(input.id === undefined ? {} : { id: text(input.id, "habit.id", 128) }),
    ...(input.name === undefined ? {} : { name: text(input.name, "habit.name", 80) }),
    ...(input.instructions === undefined ? {} : { instructions: text(input.instructions, "habit.instructions", 4000) }),
    ...(input.schedule === undefined ? {} : { schedule: habitSchedule(input.schedule) }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
  };
}

export function configuredHabit(list: Habit[], input: NonNullable<ReturnType<typeof habitInput>>, sourceMode: RuntimeMode, now: number): Habit {
  const matches = input.id
    ? list.filter(entry => entry.id === input.id)
    : list.filter(entry => entry.name === input.name);
  if (matches.length > 1) throw new Error("More than one habit has that name; pass habit.id from monos.list");
  const current = matches[0];
  if (input.id && !current) throw new Error("No habit with that id; use monos.list");
  if (!current && (!input.name || !input.instructions || !input.schedule)) {
    throw new Error("A new habit requires name, instructions and schedule");
  }
  if (!current && list.length >= HABITS_MAX) throw new Error(`A Mono can have at most ${HABITS_MAX} habits`);
  // An operator cannot give recurring work more permission than its own turn,
  // or loosen a restriction already stored on that habit.
  const runtimeMode = current?.runtimeMode && RUNTIME_MODES.indexOf(current.runtimeMode) < RUNTIME_MODES.indexOf(sourceMode)
    ? current.runtimeMode : sourceMode;
  const next: Habit = current
    ? { ...current, ...input, runtimeMode }
    : { ...newHabit({ name: input.name!, instructions: input.instructions!, schedule: input.schedule! }, now), enabled: input.enabled ?? false, runtimeMode };
  if (current && (input.schedule || (next.enabled && !current.enabled))) {
    next.nextRunAt = nextHabitRunAt(next.schedule, now);
  }
  return next;
}

export function habitView(habit: Habit) {
  return {
    id: habit.id,
    name: habit.name,
    instructions: habit.instructions,
    schedule: habitScheduleLabel(habit.schedule),
    enabled: habit.enabled,
    runtimeMode: habit.runtimeMode ?? "full-access",
  };
}

/** Ordinary operator threads configure only a Mono dedicated to their project. */
export async function handleAgentMonos(source: Session, action: string, input: Record<string, unknown>, host: AgentAppHost): Promise<unknown> {
  if (action === "monos.configure") {
    return withMonoConfigurationLock(() => handleMonoAction(source, action, input, host));
  }
  return handleMonoAction(source, action, input, host);
}

async function handleMonoAction(source: Session, action: string, input: Record<string, unknown>, host: AgentAppHost): Promise<unknown> {
  if (!host.monos || !host.habits) throw new Error("Mono configuration is unavailable in this window");
  if (host.isMono(source.id) || host.isHabitRun?.(source.id)) {
    throw new Error("Use your own soul and habits actions; monos.configure is for ordinary project sessions");
  }
  if (!isLocalProject(source.cwd)) {
    throw new Error("Mono configuration needs a local project session");
  }
  if (!host.monos.enabled()) {
    if (action === "monos.list") return { enabled: false, monos: [] };
    throw new Error("Monos are turned off; enable Monos in Settings first");
  }
  const assertScope = (id: string) => {
    if (!host.monos!.enabled()) throw new Error("Monos are turned off");
    return scopedMono(id, source.cwd);
  };
  const view = async (id: string) => {
    assertScope(id);
    const [soul, habits] = await Promise.all([
      host.readAgentFile(id, "SOUL.md"),
      host.habits!.load(id),
    ]);
    const mono = assertScope(id);
    return { id, name: monoLook(mono).name, project: mono.projects[0], instructions: soul.text ?? "", soulHash: soul.hash, habits: habits.map(habitView) };
  };
  if (action === "monos.list") {
    const monos = listMonos().filter(mono => exclusiveProject(mono, source.cwd));
    return { enabled: true, monos: await Promise.all(monos.map(mono => view(mono.id))) };
  }
  const id = input.id === undefined ? undefined : text(input.id, "id", 128);
  const name = input.name === undefined ? undefined : text(input.name, "name", 80);
  const instructions = input.instructions === undefined ? undefined : text(input.instructions, "instructions", 12_000);
  // SOUL also influences consumers configured independently in other windows.
  // Restricted sessions can configure scoped habits, but cannot replace SOUL.
  if (instructions !== undefined && source.runtimeMode !== "full-access") {
    throw new Error("Standing instructions require Full access. Use habit.instructions for recurring work with this session's permissions, or change the session permissions in MonoCode.");
  }
  const expectedSoulHash = input.expectedSoulHash === undefined ? undefined : text(input.expectedSoulHash, "expectedSoulHash", 256);
  const habit = habitInput(input.habit);
  if (!id && !name) throw new Error("Creating a Mono requires name; use id from monos.list to update one");
  const matches = id ? [assertScope(id)] : listMonos().filter(mono => exclusiveProject(mono, source.cwd) && monoLook(mono).name === name);
  if (matches.length > 1) throw new Error("More than one Mono has that name; pass id from monos.list");
  const existing = matches[0];
  const now = (host.now?.() ?? new Date()).getTime();
  // Validate the complete change before creating a roster entry or writing files.
  if (habit) {
    const habits = existing ? await host.habits.load(existing.id) : [];
    configuredHabit(habits, habit, source.runtimeMode, now);
  }
  if (existing) assertScope(existing.id);
  const mono = existing ?? createMono([source.cwd]);
  const monoId = mono.id;
  if (!existing) updateMono(monoId, current => ({ ...current, name }));
  // Establish the actual saved consumer before inspecting or changing SOUL.
  // Keep this quiet conversation on failure so a retry can safely reuse it.
  await host.monos.prepare(monoId);
  assertScope(monoId);
  if (instructions !== undefined) {
    const soul = await host.readAgentFile(monoId, "SOUL.md");
    assertScope(monoId);
    if (soul.text?.trim() !== instructions) {
      // Only an absent file can be initialized without a caller-provided hash.
      // Empty existing files and concurrent writers still require conflict protection.
      if (soul.text !== null && expectedSoulHash !== soul.hash) {
        throw new Error("Read monos.list and pass its soulHash as expectedSoulHash before replacing instructions");
      }
      await host.writeAgentFile(monoId, "SOUL.md", instructions, soul.hash);
    }
  }
  assertScope(monoId);
  if (habit) {
    await host.habits.update(monoId, list => {
      assertScope(monoId);
      const next = configuredHabit(list, habit, source.runtimeMode, now);
      return { habits: list.some(entry => entry.id === next.id) ? list.map(entry => entry.id === next.id ? next : entry) : [...list, next], result: next };
    });
  }
  assertScope(monoId);
  if (name) updateMono(monoId, current => ({ ...current, name }));
  return { mono: await view(monoId), created: !existing, note: "Configured without starting a turn. Enabled habits run on schedule while MonoCode is open, using model usage and their saved permissions." };
}
