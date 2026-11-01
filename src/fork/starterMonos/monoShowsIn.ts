import { monoWorksOn, type Mono } from "../../features/monos/model/mono";
import { isStarterMono } from "./allStarterMonos";

/**
 * Whether the sidebar and title bar list this Mono in a project. A Mono
 * with no project yet is offered in every project, so it can be found before
 * it is given one. The starter Monos (Kickoff, Maker, Sweep, Dojo) show in
 * every project always, even after one of them makes a project of its own.
 */
export function monoShowsIn(
  mono: Pick<Mono, "id" | "projects">,
  path: string,
  isStarter: (id: string) => boolean = isStarterMono,
): boolean
{
  return mono.projects.length === 0 || isStarter(mono.id) || monoWorksOn(mono, path);
}
