/**
 * Fork: show on the Mac. App.tsx registers how to open a local file as a tab
 * and which project is active; the watcher uses it without importing App.
 */
export type ShowsOpener = {
  /** Opens an absolute local path as a file tab, even in a remote project. */
  openLocalFile: (path: string) => void;
  /** The active project's path, a `remote://` path for a remote project. */
  activeProject: () => string | undefined;
};

let opener: ShowsOpener | null = null;

export function setShowsOpener(next: ShowsOpener | null): void {
  opener = next;
}

export function showsOpener(): ShowsOpener | null {
  return opener;
}
