import { monoWorksOn, type Mono } from "../../features/monos/model/mono";

/**
 * Whether the sidebar and title bar list this Mono in a project. A Mono
 * with no project yet (the starter Monos: Kickoff, Maker, Sweep, Dojo) is
 * offered in every project, so it can be found before it is given one.
 */
export function monoShowsIn(mono: Pick<Mono, "projects">, path: string): boolean
{
  return mono.projects.length === 0 || monoWorksOn(mono, path);
}
