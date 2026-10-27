import {
  loadTabGroupMascots,
  saveTabGroupMascot,
} from "../../features/workspace/model/tabGroups";
import { projectBotFor } from "./projectBots";

/** Projects that already got their bot, so a later menu pick is kept. */
const APPLIED_KEY = "monocode.fork.projectBots.applied";

function loadApplied(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** Give each listed project its own bot once. Returns the projects changed. */
export function applyProjectBots(paths: readonly string[]): string[] {
  const applied = loadApplied();
  const current = loadTabGroupMascots();
  const changed: string[] = [];
  for (const path of paths) {
    if (applied.has(path)) continue;
    const bot = projectBotFor(path);
    if (!bot) continue;
    applied.add(path);
    if (current[path] === bot) continue;
    saveTabGroupMascot(path, bot);
    changed.push(path);
  }
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify([...applied]));
  } catch {
    /* Without storage the bots are simply applied again next launch. */
  }
  return changed;
}
