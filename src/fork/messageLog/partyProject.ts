/**
 * Fork: which project a Messages row's end works in, so the row can show that
 * project's icon. Pure; the feed passes the projects MonoCode knows.
 *
 * In order: a known project the session's folder sits in; the project of a
 * `<name>-worktrees/<branch>` checkout; a known project with the folder's
 * name; the session's own folder; a known project the session's name starts
 * with (`panoptic-ee` -> panoptic). Null when nothing fits.
 */

import { projectName } from "../../shared/lib/paths";
import type { Party } from "./messageLogView";

const WORKTREES = /^(.+)-worktrees$/;

function trim(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Known project folders by their folder name; the first listed wins. */
export function projectsByName(known: readonly string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const path of known) {
    const name = path ? projectName(path) : "";
    if (name && name !== "~" && !byName.has(name)) {
      byName.set(name, path);
    }
  }
  return byName;
}

function fromCwd(cwd: string, known: readonly string[], byName: Map<string, string>): string | null {
  const folder = trim(cwd);
  let best: string | null = null;
  for (const path of known) {
    const root = path ? trim(path) : "";
    if (root && root !== "/" && (folder === root || folder.startsWith(`${root}/`))) {
      if (!best || root.length > trim(best).length) {
        best = path;
      }
    }
  }
  if (best) {
    return best;
  }
  for (const part of folder.split("/")) {
    const match = WORKTREES.exec(part);
    const found = match ? byName.get(match[1]) : undefined;
    if (found) {
      return found;
    }
  }
  return byName.get(projectName(folder)) ?? null;
}

function fromLabel(label: string, byName: Map<string, string>): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const [name, path] of byName) {
    if ((label === name || label.startsWith(`${name}-`)) && name.length > bestLength) {
      best = path;
      bestLength = name.length;
    }
  }
  return best;
}

/** The folder whose icon stands for this end, or null when unknown. */
export function partyProject(
  party: Party,
  known: readonly string[],
  byName: Map<string, string> = projectsByName(known),
): string | null {
  if (party.cwd) {
    const found = fromCwd(party.cwd, known, byName);
    if (found) {
      return found;
    }
  }
  if (party.project) {
    const found = byName.get(party.project);
    if (found) {
      return found;
    }
  }
  const byLabel = party.key.startsWith("unknown:") ? null : fromLabel(party.label, byName);
  if (byLabel) {
    return byLabel;
  }
  // Not a known project: its folder still seeds a steady mascot.
  return party.cwd || party.project || null;
}
