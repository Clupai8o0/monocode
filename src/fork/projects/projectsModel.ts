import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import { sameProjectPath } from "../../features/projects/model/recents";

export type ProjectRow = {
  path: string;
  working: number;
  waiting: number;
  done: number;
  running: boolean;
  startedAt: number;
  activity: string;
};

/** Active runs rise once when they start, never as their output streams. */
export function projectRows(
  paths: readonly string[],
  agents: readonly LiveAgent[],
  busyPaths: Iterable<string> = [],
): ProjectRow[] {
  const busy = [...busyPaths];
  return paths
    .map((path, index) => {
      const matching = agents.filter((agent) =>
        sameProjectPath(agent.cwd, path),
      );
      const working = matching.filter(
        (agent) => !agent.done && !agent.needsApproval,
      );
      const waiting = matching.filter((agent) => agent.needsApproval);
      const done = matching.filter(
        (agent) => agent.done && !agent.needsApproval,
      );
      const latest = [
        ...(working.length ? working : waiting.length ? waiting : done),
      ].sort(
        (a, b) =>
          (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id),
      )[0];
      // Working-agent previews can be disabled. The busy path still tells us
      // a project is running, but cannot provide a fabricated start time/count.
      const running =
        working.length > 0 ||
        (!matching.length && busy.some((item) => sameProjectPath(item, path)));
      return {
        path,
        working: working.length,
        waiting: waiting.length,
        done: done.length,
        running,
        startedAt: running ? (latest?.startedAt ?? 0) : 0,
        activity: latest?.activity ?? (running ? "Working" : ""),
        index,
      };
    })
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        (a.running && b.running ? b.startedAt - a.startedAt : 0) ||
        a.index - b.index,
    )
    .map(({ index: _index, ...row }) => row);
}

export function projectStatusLabel(row: ProjectRow): string {
  const labels: string[] = [];
  if (row.running) {
    labels.push(row.working > 0 ? `${row.working} running` : "Running");
  }
  if (row.waiting) {
    labels.push(`${row.waiting} ${row.waiting === 1 ? "needs" : "need"} you`);
  }
  if (row.done) {
    labels.push(`${row.done} done`);
  }
  return labels.join(" · ");
}
