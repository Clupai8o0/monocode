import {
  HABITS_MAX,
  newHabit,
  updateHabits,
} from "../../features/monos/model/monoHabits";
import { MONO_COLORS } from "../../features/monos/model/mono";
import { withMonoConfigurationLock } from "../../features/monos/model/monoConfigurationLock";
import { ensureStarterMono, type StarterMono } from "../starterMonos/starterMono";
import { DOJO_MONO } from "../starterMonos/dojoMono"; // Fork
import { SWEEP_MONO } from "../starterMonos/sweepMono";

const USAGE_REPORT =
  "~/Documents/Obsidian/brain/30-resources/_meta/claude-shared/usage_report.py";

/** A Mono made only when the owner adds the weekly usage report. */
export const TALLY_MONO: StarterMono = {
  key: "monocode.fork.tally",
  name: "Tally",
  mascot: "chip",
  color: MONO_COLORS[1],
  soul: `You are Tally. Once a week you report what Claude usage cost and where it went.

Run \`python3 ${USAGE_REPORT}\` and read its output. You never change code or settings.

Reply with one line for the answer (total spend this week, up or down on last week), then a short table of the biggest costs, then at most two plain suggestions. No divider lines.`,
};

export type HabitPreset = {
  id: string;
  name: string;
  why: string;
  when: string;
  mono: StarterMono;
  instructions: string;
};

const MONDAY = 1;
const FRIDAY = 5;
const SUNDAY = 0; // Fork

export const HABIT_PRESETS: readonly (HabitPreset & { dayOfWeek: number; time: string })[] = [
  {
    id: "weekly-sweep",
    name: "Weekly cleanup",
    why: "Sweep clears caches and build output, and asks before anything it can't get back.",
    when: "Fridays at 5 pm",
    mono: SWEEP_MONO,
    dayOfWeek: FRIDAY,
    time: "17:00",
    instructions:
      "Do a quick cleanup: survey, then clear the safe group only. Report the space freed. If under 1 GB could be freed, reply with NOTHING_TO_REPORT.",
  },
  {
    id: "weekly-usage",
    name: "Weekly usage report",
    why: "Tally reads your local usage log and tells you what the week cost and where it went.",
    when: "Mondays at 9 am",
    mono: TALLY_MONO,
    dayOfWeek: MONDAY,
    time: "09:00",
    instructions: "Report this week's usage.",
  },
  {
    // Fork: Dojo reviews the week's practice from the Code tab's progress.
    id: "weekly-learning",
    name: "Weekly learning review",
    why: "Dojo reads what you practiced in the Code tab, says what stuck and what is due, and sets the next drills.",
    when: "Sundays at 10 am",
    mono: DOJO_MONO,
    dayOfWeek: SUNDAY,
    time: "10:00",
    instructions:
      "Review this week's learning: read progress.json and progress.md in your folder, say what moved and what is due for review, and set the next drills. If nothing was practiced, reply with NOTHING_TO_REPORT.",
  },
];

/**
 * Offered, never switched on by itself: this runs only from an Add click. Two
 * windows can't add it twice: the lock covers making the Mono, and the name
 * check sits inside the same read-and-write of the habit list.
 */
export function addHabitPreset(
  preset: (typeof HABIT_PRESETS)[number],
): Promise<void> {
  return withMonoConfigurationLock(async () => {
    const monoId = ensureStarterMono(preset.mono);
    if (!monoId) {
      throw new Error(`${preset.mono.name} was deleted, so this can't be added.`);
    }
    await updateHabits(monoId, (habits) => {
      if (habits.some((habit) => habit.name === preset.name)) {
        return { habits, result: undefined };
      }
      if (habits.length >= HABITS_MAX) {
        throw new Error(`A Mono can have at most ${HABITS_MAX} habits`);
      }
      const habit = newHabit(
        {
          name: preset.name,
          instructions: preset.instructions,
          schedule: {
            scheduleKind: "weekly",
            minute: 0,
            time: preset.time,
            dayOfWeek: preset.dayOfWeek,
          },
        },
        Date.now(),
      );
      return { habits: [...habits, habit], result: undefined };
    });
  });
}
