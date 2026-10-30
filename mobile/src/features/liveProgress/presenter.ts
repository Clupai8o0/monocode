import type { LiveProgress } from "./liveProgress";

/** Platforms with no lock screen card. iOS and Android have their own files. */
export async function showProgress(_progress: LiveProgress | null) {}
