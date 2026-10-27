import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";

import {
  CodeHeaderTitle,
  HeaderBlur,
  HeaderButton,
} from "@/features/files/codeScreen";
import { TerminalView } from "@/features/terminal/TerminalView";
import { projectForRoute } from "@/features/workspace/routing";
import { useWorkspace } from "@/features/workspace/WorkspaceProvider";
import { useColors } from "@/ui/theme";

// The project's shell on its host, in a native modal over the session, beside
// Files and Changes. Closing it leaves the shell running for next time.
export default function TerminalRoute() {
  const { projectId, worktreePath } = useLocalSearchParams<{
    projectId: string;
    worktreePath?: string;
  }>();
  const project = projectForRoute(useWorkspace().projects, projectId);
  const headerHeight = useHeaderHeight();
  const colors = useColors();
  if (!project) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <CodeHeaderTitle name="Terminal">
              {worktreePath || project.path || project.name}
            </CodeHeaderTitle>
          ),
          headerLeft: () => (
            <HeaderButton icon="close" label="Close" onPress={() => router.back()} />
          ),
        }}
      />
      <TerminalView
        projectId={project.id}
        worktreePath={worktreePath || undefined}
        top={headerHeight}
      />
      <HeaderBlur color={colors.background} />
    </>
  );
}
