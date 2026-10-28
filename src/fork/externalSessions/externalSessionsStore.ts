import type {
  ExternalSession,
  ExternalSessionsTarget,
  ExternalTranscriptPage,
} from "./externalSessionsModel";

export type ExternalSessionsState = {
  sessions: ExternalSession[];
  loading: boolean;
  /** The last read failed; `sessions` keeps the last good list. */
  error?: string;
  /** False when the machine's host predates this feature. */
  supported: boolean;
  refresh: () => void;
};

/**
 * One project's sessions elsewhere, kept fresh while shown. Stub until the
 * data layer lands: it returns nothing and reports the feature unsupported.
 */
export function useExternalSessions(
  target: ExternalSessionsTarget | undefined,
): ExternalSessionsState {
  void target;
  return { sessions: [], loading: false, supported: false, refresh: () => {} };
}

/** One page of a session's turns; the newest page when `before` is absent. */
export async function readExternalSession(
  target: ExternalSessionsTarget,
  sessionId: string,
  before?: number,
): Promise<ExternalTranscriptPage> {
  void target;
  void sessionId;
  void before;
  return { turns: [] };
}
