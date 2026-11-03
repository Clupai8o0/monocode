import { loadBest, saveBest, type BestScores } from "./gamesPanelStore";

/**
 * Fork: the running score, kept out of React state. A score can change many
 * times a second, and only the small readout in the panel's header needs to
 * hear about it; the panel, the board and the tables don't re-render for it.
 */

export type LiveScore = { score: number; lives: number; best: BestScores };

/** A record run beats its best on every point, so the disk hears at most this often. */
const SAVE_EVERY_MS = 1000;

let live: LiveScore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function liveScore(): LiveScore
{
    live ??= { score: 0, lives: 0, best: loadBest() };
    return live;
}

export function subscribeLiveScore(listener: () => void): () => void
{
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Writes a new best now rather than waiting for the timer. */
export function flushBest(): void
{
    if (saveTimer === null) {
        return;
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    saveBest(liveScore().best);
}

export function reportScore(gameId: string, score: number, lives: number): void
{
    const was = liveScore();
    const record = score > (was.best[gameId] ?? 0);
    if (!record && score === was.score && lives === was.lives) {
        return;
    }
    live = {
        score,
        lives,
        best: record ? { ...was.best, [gameId]: score } : was.best,
    };
    if (record && saveTimer === null) {
        saveTimer = setTimeout(flushBest, SAVE_EVERY_MS);
    }
    for (const listener of listeners) {
        listener();
    }
}

/** Tests only. */
export function resetLiveScoreForTest(): void
{
    if (saveTimer !== null) {
        clearTimeout(saveTimer);
    }
    saveTimer = null;
    live = null;
    listeners.clear();
}
