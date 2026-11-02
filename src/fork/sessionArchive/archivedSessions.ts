type Row = { archived?: boolean; harness: string };

/**
 * What the main session list draws from. Archiving only tidies that list; a
 * search still reaches everything the project has stored.
 */
export function mainListSessions<T extends { archived?: boolean }>(
  rows: T[],
  showArchived: boolean,
  query: string,
): T[] {
  if (query.trim()) {
    return rows;
  }
  return rows.filter((row) => !!row.archived === showArchived);
}

/**
 * The rows of the Archived group under the list. Time and status filters do not
 * touch it, so a stored session is never out of reach. It stands aside while
 * the main list already shows archived rows (the filter, or a search).
 */
export function archivedGroupSessions<T extends Row>(
  rows: readonly T[],
  options: {
    showArchived: boolean;
    query: string;
    hiddenHarnesses: readonly string[];
  },
): T[] {
  if (options.showArchived || options.query.trim()) {
    return [];
  }
  return rows.filter(
    (row) => row.archived && !options.hiddenHarnesses.includes(row.harness),
  );
}

/** The sessions the 12-hour cleanup may archive: never one open in a tab. */
export function autoArchiveCandidates<T extends { id: string }>(
  candidates: readonly T[],
  openIds: readonly string[],
): T[] {
  const open = new Set(openIds);
  return candidates.filter((candidate) => !open.has(candidate.id));
}
