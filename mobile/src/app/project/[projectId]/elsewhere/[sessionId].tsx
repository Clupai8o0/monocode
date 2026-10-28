import { useLocalSearchParams } from "expo-router";

import { ElsewhereScreen } from "@/features/sessions/ElsewhereScreen";
import { projectForRoute } from "@/features/workspace/routing";
import { useWorkspace } from "@/features/workspace/WorkspaceProvider";

// A session MonoCode did not start, to read only, presented as a native
// modal (see the root layout).
export default function ElsewhereRoute() {
  const { projectId, sessionId, name, source, state } = useLocalSearchParams<{
    projectId: string;
    sessionId: string;
    name?: string;
    source?: string;
    state?: string;
  }>();
  // Router params arrive decoded; requests need the catalog's ID.
  const project = projectForRoute(useWorkspace().projects, projectId);
  return (
    <ElsewhereScreen
      projectId={project?.id ?? projectId}
      sessionId={sessionId}
      name={name}
      source={source}
      state={state}
    />
  );
}
