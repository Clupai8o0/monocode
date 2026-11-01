import { DOJO_MONO } from "./dojoMono";
import { KICKOFF_MONO } from "./kickoffMono";
import { MONO_MAKER } from "./makerMono";
import { starterMonoId, type StarterMono } from "./starterMono";
import { SWEEP_MONO } from "./sweepMono";

/** Fork: every Mono the app makes once, in rail order. */
export const STARTER_MONOS: readonly StarterMono[] = [KICKOFF_MONO, MONO_MAKER, SWEEP_MONO, DOJO_MONO];

/**
 * Whether this Mono is one of the app's starter Monos. They are helpers for
 * every project, so a project one of them makes (Kickoff's new project,
 * Dojo's folder) never hides it from the rest.
 */
export function isStarterMono(id: string): boolean
{
  return STARTER_MONOS.some((spec) => starterMonoId(spec) === id);
}
