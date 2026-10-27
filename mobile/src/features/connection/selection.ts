export type MobileSelection = { projectIds: string[]; monoIds: string[] };

/**
 * Whether monos can be picked and shown. Each one opens as its own
 * conversation, from the project switcher; hosts serve them since phone v2.
 */
export const MONOS_ENABLED = true;
export function normalizeSelection(value: unknown): MobileSelection | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.projectIds) || !Array.isArray(item.monoIds))
    return null;
  const ids = (values: unknown[]) => [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ];
  return { projectIds: ids(item.projectIds), monoIds: ids(item.monoIds) };
}
export function selectedWorkspace<
  T extends {
    projects: { id: string }[];
    monos: { id: string }[];
    sessions: { projectId: string; monoId?: string }[];
  },
>(catalog: T, selection: MobileSelection | null) {
  const projects = new Set(selection?.projectIds ?? []);
  const monos = new Set(MONOS_ENABLED ? (selection?.monoIds ?? []) : []);
  return {
    ...catalog,
    projects: catalog.projects.filter((project) => projects.has(project.id)),
    monos: catalog.monos.filter((mono) => monos.has(mono.id)),
    sessions: catalog.sessions.filter(
      (session) =>
        projects.has(session.projectId) ||
        (!!session.monoId && monos.has(session.monoId)),
    ),
  };
}
