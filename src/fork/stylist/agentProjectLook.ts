import { projectKey, projectName } from "../../shared/lib/paths";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupLogoBackgrounds,
  loadTabGroupLogos,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
  TAB_GROUP_COLORS,
} from "../../features/workspace/model/tabGroups";
import {
  PROJECT_MASCOTS,
  projectMascot,
} from "../../features/projects/model/projectMascots";

/**
 * Fork: a project's whole look (name, color, mascot, logo) for `/operator`
 * agents, so the Stylist Mono can personalise each project the same way the
 * project menu does. Logos keep their own `projects.logo*` actions.
 */
export type ProjectLook = {
  project: string;
  name: string;
  label: string | null;
  color: { value: string; palette: number | null; custom: string | null };
  mascot: { name: string; saved: string | null };
  logo: string | null;
  background: string;
  /** Where a Mono may save icons it makes; `projects.logo.set` accepts them. */
  iconsDir: string | null;
  choices: { colors: { index: number; value: string }[]; mascots: string[] };
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const LABEL_MAX = 40;

export function projectLook(cwd: string, iconsDir: string | null = null): ProjectLook {
  const key = projectKey(cwd);
  const name = projectName(cwd);
  const colors = loadTabGroupColors();
  const custom = loadTabGroupCustomColors();
  const saved = loadTabGroupMascots()[key] ?? null;
  return {
    project: cwd,
    name,
    label: loadTabGroupLabels()[key]?.trim() || null,
    color: {
      value: resolveTabGroupColor(key, colors, custom, name),
      palette: resolveTabGroupColorIndex(key, colors, custom),
      custom: resolveTabGroupCustomColor(key, custom),
    },
    mascot: { name: projectMascot(name, saved).name, saved },
    logo: loadTabGroupLogos()[key] ?? null,
    background: loadTabGroupLogoBackgrounds()[key] ?? "transparent",
    iconsDir,
    choices: {
      // Index 0 is the neutral grey the hashed default never picks.
      colors: TAB_GROUP_COLORS.map((value, index) => ({ index, value })),
      mascots: PROJECT_MASCOTS.map((mascot) => mascot.name),
    },
  };
}

type LookChange = {
  label?: string | null;
  color?: string | number | null;
  mascot?: string | null;
};

/** Checks every field before saving any, so a bad input changes nothing. */
function lookChange(input: Record<string, unknown>): LookChange {
  const change: LookChange = {};
  if (input.label !== undefined) {
    if (input.label !== null && (typeof input.label !== "string" || input.label.trim().length > LABEL_MAX)) {
      throw new Error(`label must be text up to ${LABEL_MAX} characters, or null for the folder name`);
    }
    change.label = input.label === null ? null : (input.label as string).trim();
  }
  if (input.color !== undefined) {
    const color = input.color;
    const index = typeof color === "number" && Number.isInteger(color) && color >= 0 && color < TAB_GROUP_COLORS.length;
    if (color !== null && !index && !(typeof color === "string" && HEX.test(color))) {
      throw new Error(`color must be a palette index 0-${TAB_GROUP_COLORS.length - 1}, a #rrggbb hex, or null for the default`);
    }
    change.color = color as string | number | null;
  }
  if (input.mascot !== undefined) {
    const mascot = input.mascot;
    if (mascot !== null && !(typeof mascot === "string" && PROJECT_MASCOTS.some((entry) => entry.name === mascot))) {
      throw new Error("mascot must be one of choices.mascots from projects.look, or null for the default");
    }
    change.mascot = mascot as string | null;
  }
  if (!Object.keys(change).length) {
    throw new Error("Pass at least one of label, color or mascot");
  }
  return change;
}

export function setProjectLook(
  cwd: string,
  input: Record<string, unknown>,
  iconsDir: string | null = null,
): ProjectLook {
  const change = lookChange(input);
  const key = projectKey(cwd);
  if (change.label !== undefined) saveTabGroupLabel(key, change.label ?? "");
  if (change.color !== undefined) {
    if (typeof change.color === "string") saveTabGroupCustomColor(key, change.color);
    else saveTabGroupColor(key, change.color);
  }
  if (change.mascot !== undefined) saveTabGroupMascot(key, change.mascot);
  return projectLook(cwd, iconsDir);
}
