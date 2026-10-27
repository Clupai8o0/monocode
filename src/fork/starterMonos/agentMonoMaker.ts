import type { AgentAppHost } from "../../features/agent-app/model/agentApp";
import { configuredHabit, habitInput, habitView } from "../../features/agent-app/model/agentAppMonos";
import {
  createMono,
  findMono,
  listMonos,
  MONO_COLORS,
  monoLook,
  removeMono,
  updateMono,
  type Mono,
} from "../../features/monos/model/mono";
import { withMonoConfigurationLock } from "../../features/monos/model/monoConfigurationLock";
import { PROJECT_MASCOTS } from "../../features/projects/model/projectMascots";
import { isLocalProject, loadRecents } from "../../features/projects/model/recents";
import type { Session } from "../../features/sessions/model/session";
import { pathKey, projectName } from "../../shared/lib/paths";
import { MONO_MAKER } from "./makerMono";
import { starterMonoId } from "./starterMono";

/**
 * Fork: `monos.all` and `monos.make`, which only the Mono Maker's own chat may
 * call. Unlike `monos.configure` (one project's own Monos), it sees every Mono
 * and sets a Mono's look and projects too. It never deletes one, and changes
 * itself only through soul.update.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;
const PROJECTS_MAX = 50;
const SOUL_CHANGED = "Its SOUL.md exists or changed; read it with monos.all {\"id\"} and pass soulHash as expectedSoulHash";

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be non-empty text (at most ${max} characters)`);
  }
  return value.trim();
};

function railProjects(): string[] {
  return loadRecents().map((project) => project.path).filter(isLocalProject);
}

function summary(mono: Mono) {
  const look = monoLook(mono);
  return { id: mono.id, name: look.name, mascot: look.mascot, color: look.color, projects: look.projects };
}

function choices() {
  return {
    mascots: PROJECT_MASCOTS.map((mascot) => mascot.name),
    colors: MONO_COLORS.map((value, index) => ({ index, value })),
    projects: railProjects().map((path) => ({ path, name: projectName(path) })),
  };
}

/** Each named project by path or folder name, from the project rail. */
function resolveProjects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PROJECTS_MAX) {
    throw new Error(`projects must be a list of up to ${PROJECTS_MAX} project paths or names`);
  }
  const rail = railProjects();
  return value.map((entry) => {
    const named = text(entry, "Each project", 4096);
    const byPath = rail.find((path) => pathKey(path) === pathKey(named));
    const byName = rail.filter((path) => projectName(path) === named);
    const match = byPath ?? (byName.length === 1 ? byName[0] : undefined);
    if (!match) {
      throw new Error(`${named} is not one project on the rail; see choices.projects in monos.all`);
    }
    return match;
  });
}

function colorInput(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MONO_COLORS.length) {
    return MONO_COLORS[value];
  }
  if (typeof value === "string" && HEX.test(value)) return value.toLowerCase();
  throw new Error(`color must be a palette index 0-${MONO_COLORS.length - 1} or a #rrggbb hex`);
}

function mascotInput(value: unknown): string {
  if (typeof value === "string" && PROJECT_MASCOTS.some((mascot) => mascot.name === value)) return value;
  throw new Error("mascot must be one of choices.mascots from monos.all");
}

export async function handleMonoMaker(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const makerId = starterMonoId(MONO_MAKER);
  if (!makerId || !host.isMono(source.id) || host.monoOf?.(source.id)?.id !== makerId) {
    throw new Error(`${action} is only for the Mono Maker's own chat`);
  }
  if (!host.monos || !host.habits) throw new Error("Mono configuration is unavailable in this window");
  if (!host.monos.enabled()) throw new Error("Monos are turned off");
  if (action === "monos.all") return monosAll(input, host);
  return withMonoConfigurationLock(() => monosMake(source, makerId, input, host));
}

async function detail(id: string, host: AgentAppHost) {
  const [soul, habits] = await Promise.all([host.readAgentFile(id, "SOUL.md"), host.habits!.load(id)]);
  const mono = findMono(id);
  if (!mono) throw new Error("That Mono was removed");
  return { ...summary(mono), instructions: soul.text ?? "", soulHash: soul.hash, habits: habits.map(habitView) };
}

async function monosAll(input: Record<string, unknown>, host: AgentAppHost) {
  if (input.id !== undefined) {
    const id = text(input.id, "id", 128);
    if (!findMono(id)) throw new Error("No Mono with that id; use monos.all");
    return detail(id, host);
  }
  const monos = await Promise.all(listMonos().map(async (mono) => ({
    ...summary(mono),
    habits: (await host.habits!.load(mono.id)).length,
  })));
  return { monos, choices: choices() };
}

async function monosMake(source: Session, makerId: string, input: Record<string, unknown>, host: AgentAppHost) {
  const id = input.id === undefined ? undefined : text(input.id, "id", 128);
  if (id === makerId) throw new Error("Change your own instructions with soul.update");
  const existing = id ? findMono(id) : undefined;
  if (id && !existing) throw new Error("No Mono with that id; use monos.all");
  const name = input.name === undefined ? undefined : text(input.name, "name", 40);
  if (!existing && !name) throw new Error("A new Mono needs a name");
  if (!existing && listMonos().some((mono) => monoLook(mono).name === name)) {
    throw new Error("A Mono already has that name; pass its id to change it, or pick another name");
  }
  const mascot = input.mascot === undefined ? undefined : mascotInput(input.mascot);
  const color = input.color === undefined ? undefined : colorInput(input.color);
  const projects = input.projects === undefined ? undefined : resolveProjects(input.projects);
  const instructions = input.instructions === undefined ? undefined : text(input.instructions, "instructions", 12_000);
  // Standing instructions drive all of the Mono's future work.
  if (instructions !== undefined && source.runtimeMode !== "full-access") {
    throw new Error("Standing instructions need Full access; change this chat's permissions in MonoCode");
  }
  const expectedSoulHash = input.expectedSoulHash === undefined
    ? undefined : text(input.expectedSoulHash, "expectedSoulHash", 256);
  const habit = habitInput(input.habit);
  const now = (host.now?.() ?? new Date()).getTime();
  // Check the whole change before making anything.
  if (habit) configuredHabit(existing ? await host.habits!.load(existing.id) : [], habit, source.runtimeMode, now);

  // A SOUL.md that exists is checked before anything changes.
  const soulBefore = existing && instructions !== undefined
    ? await host.readAgentFile(existing.id, "SOUL.md") : undefined;
  if (soulBefore && soulBefore.text !== null && soulBefore.text.trim() !== instructions && expectedSoulHash !== soulBefore.hash) {
    throw new Error(SOUL_CHANGED);
  }

  const monoId = existing?.id ?? createMono(projects ?? []).id;
  try {
    return await applyMake(source, monoId, existing, { name, mascot, color, projects, instructions, expectedSoulHash, habit, now }, host);
  } catch (error) {
    // Nothing is left half done: a new Mono goes, an old one gets its look back.
    if (!existing) {
      removeMono(monoId);
    } else {
      updateMono(monoId, (current) => ({
        ...current,
        name: existing.name,
        mascot: existing.mascot,
        color: existing.color,
        projects: existing.projects,
      }));
    }
    throw error;
  }
}

type Make = {
  name?: string;
  mascot?: string;
  color?: string;
  projects?: string[];
  instructions?: string;
  expectedSoulHash?: string;
  habit: ReturnType<typeof habitInput>;
  now: number;
};

async function applyMake(
  source: Session,
  monoId: string,
  existing: Mono | undefined,
  { name, mascot, color, projects, instructions, expectedSoulHash, habit, now }: Make,
  host: AgentAppHost,
) {
  updateMono(monoId, (current) => ({
    ...current,
    ...(name ? { name } : {}),
    ...(mascot ? { mascot } : {}),
    ...(color ? { color } : {}),
    ...(projects ? { projects } : {}),
    // A new Mono's SOUL.md is seeded from this the first time its files load.
    ...(!existing && instructions !== undefined ? { instructions } : {}),
  }));
  // Its conversation, quietly, with this chat's provider, model and permissions.
  await host.monos!.prepare(monoId);
  if (!findMono(monoId)) throw new Error("That Mono was removed");
  if (instructions !== undefined) {
    const soul = await host.readAgentFile(monoId, "SOUL.md");
    if (soul.text?.trim() !== instructions) {
      if (soul.text !== null && expectedSoulHash !== soul.hash) {
        throw new Error(SOUL_CHANGED);
      }
      await host.writeAgentFile(monoId, "SOUL.md", instructions, soul.hash);
    }
  }
  if (habit) {
    await host.habits!.update(monoId, (list) => {
      const next = configuredHabit(list, habit, source.runtimeMode, now);
      return {
        habits: list.some((entry) => entry.id === next.id)
          ? list.map((entry) => (entry.id === next.id ? next : entry))
          : [...list, next],
        result: next,
      };
    });
  }
  return {
    mono: await detail(monoId, host),
    created: !existing,
    note: "Made without starting a turn. It is on the Monos rail; habits stay paused unless enabled:true.",
  };
}
