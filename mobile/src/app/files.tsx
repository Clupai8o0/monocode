import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import {
  CodeHeaderTitle,
  HeaderBlur,
  HeaderButton,
} from "@/features/files/codeScreen";
import { FilesView } from "@/features/files/FilesView";
import { SheetLayout } from "@/features/sessions/SessionScreen";
import type { Project } from "@/features/workspace/types";
import { projectForRoute } from "@/features/workspace/routing";
import { useWorkspace } from "@/features/workspace/WorkspaceProvider";
import { useColors } from "@/ui/theme";

// The working copy's file tree, in a native modal over the session, as the
// desktop's explorer (see the root layout). Tapping a file opens it over this.
export default function FilesRoute() {
  const { projectId, worktreePath } = useLocalSearchParams<{
    projectId: string;
    worktreePath?: string;
  }>();
  // The route decodes the project's ID back to its path; the host wants the ID.
  const project = projectForRoute(useWorkspace().projects, projectId);
  if (!project) return <Redirect href="/" />;
  return (
    <ProjectFiles project={project} worktreePath={worktreePath || undefined} />
  );
}

function ProjectFiles({
  project,
  worktreePath,
}: {
  project: Project;
  worktreePath?: string;
}) {
  const headerHeight = useHeaderHeight();
  const colors = useColors();
  return (
    // A modal is its own native view hierarchy, so its gestures need their own root.
    <GestureHandlerRootView style={styles.root}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <CodeHeaderTitle name="Files">
              {worktreePath ?? project.path ?? project.name}
            </CodeHeaderTitle>
          ),
          headerLeft: () => (
            <HeaderButton icon="close" label="Close" onPress={() => router.back()} />
          ),
        }}
      />
      <SheetLayout top={headerHeight}>
        <FilesView
          projectId={project.id}
          worktreePath={worktreePath}
          active
        />
      </SheetLayout>
      <HeaderBlur color={colors.background} />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
