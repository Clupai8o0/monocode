import { router, Stack, useLocalSearchParams } from "expo-router";
import { Fragment, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { formatCount } from "@/features/changes/diffTheme";
import { projectMachineLabel } from "@/features/connection/machineLabel";
import { PixelMascot } from "@/features/mascots/PixelMascot";
import { ProjectMascot } from "@/features/mascots/ProjectMascot";
import { SettingsPage, SettingsRow } from "@/features/settings/SettingsUI";
import { pickProject } from "@/features/workspace/projectPick";
import { projectForRoute } from "@/features/workspace/routing";
import { useWorkspace } from "@/features/workspace/WorkspaceProvider";
import { Icon } from "@/ui/Icon";
import { themedStyles, useColors } from "@/ui/theme";

/** Frames the picked row's spinner is drawn for before the switch takes JS. */
const SPINNER_FRAMES = 2;

// The project switch, from the header's menu button: every project, the one
// open checked, narrowed by the search in the header. Picking spins on the
// row while the screen under it switches, then closes.
export default function ProjectsScreen() {
  const colors = useColors();
  const styles = useStyles();
  const { current } = useLocalSearchParams<{ current?: string }>();
  const { projects, monos } = useWorkspace();
  const selected = projectForRoute(projects, current);
  const [switching, setSwitching] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? projects.filter((project) =>
        project.name.toLowerCase().includes(needle),
      )
    : projects;
  const shownMonos = needle
    ? monos.filter((mono) => mono.name.toLowerCase().includes(needle))
    : monos;
  const openMono = (id: string) => {
    if (switching) return;
    router.back();
    router.push({ pathname: "/mono/[monoId]", params: { monoId: id } });
  };
  const pick = (id: string) => {
    if (switching) return;
    if (id === selected?.id) return router.back();
    setSwitching(id);
    afterFrames(SPINNER_FRAMES, () => {
      // A project screen switches itself under the sheet; any other is
      // replaced by the project's once the sheet is gone.
      if (!pickProject(id)) {
        router.back();
        return router.replace({
          pathname: "/project/[projectId]",
          params: { projectId: id },
        });
      }
      // Closed once the switched screen has been drawn under the sheet.
      afterFrames(2, () => router.back());
    });
  };
  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search projects",
            hideWhenScrolling: false,
            autoCapitalize: "none",
            onChangeText: (event) => setQuery(event.nativeEvent.text),
          },
        }}
      />
      <SettingsPage>
        {shown.map((project, index) => (
          <Fragment key={project.id}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <SettingsRow
              icon={
                <ProjectMascot
                  project={project.path}
                  name={project.mascot}
                  color={project.color}
                  size={20}
                />
              }
              label={project.name}
              accessory={
                <View style={styles.trailing}>
                  {project.machineName ? (
                    <Text style={styles.machine} numberOfLines={1}>
                      {projectMachineLabel(project)}
                    </Text>
                  ) : null}
                  {project.additions || project.deletions ? (
                    <Text style={styles.counts} numberOfLines={1}>
                      <Text style={{ color: colors.additions }}>
                        {`+${formatCount(project.additions)}`}
                      </Text>{" "}
                      <Text style={{ color: colors.deletions }}>
                        {`-${formatCount(project.deletions)}`}
                      </Text>
                    </Text>
                  ) : null}
                  {switching === project.id ? (
                    <ActivityIndicator size="small" color={colors.muted} />
                  ) : project.id === (switching ? null : selected?.id) ? (
                    <Icon name="check" size={18} color={colors.accent} />
                  ) : null}
                </View>
              }
              onPress={() => pick(project.id)}
            />
          </Fragment>
        ))}
        {shownMonos.length ? (
          <Text style={styles.heading}>Monos</Text>
        ) : null}
        {shownMonos.map((mono) => (
          <SettingsRow
            key={mono.id}
            icon={
              <PixelMascot
                name={mono.mascot}
                color={mono.color}
                status={mono.status}
                size={20}
              />
            }
            label={mono.name}
            onPress={() => openMono(mono.id)}
          />
        ))}
        {needle && !shown.length && !shownMonos.length ? (
          <Text style={styles.empty}>No projects match.</Text>
        ) : null}
      </SettingsPage>
    </>
  );
}

function afterFrames(frames: number, then: () => void) {
  requestAnimationFrame(() =>
    frames <= 1 ? then() : afterFrames(frames - 1, then),
  );
}

const useStyles = themedStyles((colors) => ({
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 40,
    backgroundColor: colors.stroke,
  },
  // The lines changed, as the host last counted them, before the check.
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  // The remote machine a relayed project is on: a tinted pill, no border.
  machine: {
    maxWidth: 140,
    color: colors.muted,
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: colors.stroke,
  },
  counts: {
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  heading: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 28,
    marginBottom: 6,
    marginLeft: 16,
  },
  empty: {
    color: colors.muted,
    fontSize: 15,
    textAlign: "center",
    marginTop: 24,
  },
}));
