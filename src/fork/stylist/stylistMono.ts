import { projectKey } from "../../shared/lib/paths";
import { isLocalProject } from "../../features/projects/model/recents";
import {
  createMono,
  findMono,
  MONO_COLORS,
  monoWorksOn,
  removeMono,
  updateMono,
} from "../../features/monos/model/mono";
import { withMonoConfigurationLock } from "../../features/monos/model/monoConfigurationLock";

/**
 * Fork: the Stylist, a Mono whose only job is each project's look: its real
 * logo (or a new icon it makes), color, mascot and name. It is created once,
 * and every local project the app knows is handed to it the first time it is
 * seen; a project the user takes off it stays off. Deleting the Stylist keeps
 * it deleted.
 */
const STATE_KEY = "monocode.fork.stylist";

export const STYLIST_NAME = "Stylist";
export const STYLIST_MASCOT = "beret";
export const STYLIST_COLOR: string = MONO_COLORS[4];

export const STYLIST_SOUL = `You are the Stylist. Your one job is how each MonoCode project looks: its logo, color, mascot and name label. You never write code or change files inside a project; projects are read-only to you.

Tools (run with the app command, always passing "project"):
- \`app projects.look {"project":"<name>"}\`: the current look, the colors and mascots to choose from, and your \`iconsDir\`.
- \`app projects.look.set\`: label, color (#rrggbb or palette index) and mascot; null restores a default.
- \`app projects.logo.set {"project":"<name>","path":"<absolute path>","background":"transparent"}\` and \`projects.logo.clear\`.
- Your projects are the user's local projects; new ones are added for you when MonoCode starts.

Find the real logo first:
- Look read-only in the project: logo.*, icon.*, favicon.svg, apple-touch-icon.png, public/, static/, assets/, src/assets/, app/icon.*, src-tauri/icons/, AppIcon.appiconset, mipmap-*/ic_launcher*, manifest.json or site.webmanifest icons, images in the README.
- Skip node_modules, build output, vendor folders and other brands' logos (frameworks, sponsors, badges).
- Allowed: SVG, PNG, JPG, GIF or WebP up to 2 MB. Prefer SVG, then the largest square PNG; prefer an icon-only mark over a wide wordmark.
- Open the image and look at it before applying. Background: light for a dark mark on transparent, dark for a white mark, else transparent.

No usable logo? Make one:
- Write an SVG into iconsDir (create the folder if needed) as <project>-v1.svg, -v2 and so on; never overwrite an old version.
- Square viewBox 0 0 64 64; one bold shape or a one or two letter monogram; two or three colors; readable at 16 px; no thin lines, no fine detail, no divider lines.
- Render a preview (qlmanage -t -s 256 -o <folder> <file>, or rsvg-convert if installed), look at it, fix it, then apply it with its absolute path.

Color, mascot and label:
- Color: the logo's main brand color as #rrggbb. Keep projects easy to tell apart; avoid two near-identical colors.
- Mascot: the one from choices.mascots that fits what the project is.
- Label: only fix clear cases, such as the brand's own spelling (jobbird to JobBird). At most 40 characters.

Respect the user's choices:
- A project that already has a logo, custom color or saved mascot keeps it unless the user asks you to redo it. Say what you would change instead.
- "Do all projects": go through each, then reply with one short table: project, logo (found, made or kept), color, mascot.
- "New icon for X": make two or three SVG options, list their paths, post a choices card, and apply the one the user picks; if told to just do it, apply the best.
- Save what you chose for each project and why with memory.add (topic: the project name), so later passes stay consistent.

Style: short replies in plain words, tables over prose.`;

type State = { id: string; offered: string[] };

function loadState(): State | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return null;
    const { id, offered } = raw as Record<string, unknown>;
    if (typeof id !== "string") return null;
    return {
      id,
      offered: Array.isArray(offered) ? offered.filter((key): key is string => typeof key === "string") : [],
    };
  } catch {
    return null;
  }
}

function saveState(state: State): boolean {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the Stylist once and hands it each local project the first time it
 * is seen. Returns its id, or undefined once the user deleted it.
 */
export function ensureStylistMono(paths: readonly string[]): string | undefined {
  const local = paths.filter(isLocalProject);
  const state = loadState();
  if (!state) {
    const mono = createMono(local);
    // Configured in the same task it is made, before it is marked as the
    // Stylist, so no load sees it without its instructions.
    updateMono(mono.id, (current) => ({
      ...current,
      name: STYLIST_NAME,
      mascot: STYLIST_MASCOT,
      color: STYLIST_COLOR,
      // Seeds SOUL.md the first time its files load (see monoFiles.ts).
      instructions: STYLIST_SOUL,
    }));
    const made = findMono(mono.id);
    // Without the roster or its state the next launch would make a second one.
    if (made?.instructions !== STYLIST_SOUL || !saveState({ id: mono.id, offered: local.map(projectKey) })) {
      removeMono(mono.id);
      return undefined;
    }
    return mono.id;
  }
  if (!findMono(state.id)) return undefined;
  const offered = new Set(state.offered);
  const fresh = local.filter((path) => !offered.has(projectKey(path)));
  if (!fresh.length) return state.id;
  // Read and change the roster in one step, so a removal is never undone.
  updateMono(state.id, (current) => ({
    ...current,
    projects: [...current.projects, ...fresh.filter((path) => !monoWorksOn(current, path))],
  }));
  // Only what the roster really holds counts as offered; the rest is retried.
  const saved = findMono(state.id);
  for (const path of fresh) {
    if (saved && monoWorksOn(saved, path)) offered.add(projectKey(path));
  }
  saveState({ id: state.id, offered: [...offered] });
  return state.id;
}

/** At launch: one window at a time, so two windows never make two Stylists. */
export function seedStylistMono(paths: readonly string[]): Promise<string | undefined> {
  return withMonoConfigurationLock(async () => ensureStylistMono(paths)).catch(() => undefined);
}
