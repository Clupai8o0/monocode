import { router, Stack, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { formatCount, splitPath } from "@/features/changes/diffTheme";
import { keepDiff } from "@/features/changes/shownDiffs";
import { shownTurn } from "@/features/changes/shownTurns";
import { HeaderButton } from "@/features/files/codeScreen";
import { themedStyles, useColors } from "@/ui/theme";

/** Read-only: what one reply changed. Each file opens its diff. */
export default function TurnScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const styles = useStyles();
  const changes = shownTurn(id);
  return (
    <>
      <Stack.Screen
        options={{
          title: "This turn",
          headerLeft: () => (
            <HeaderButton icon="close" label="Close" onPress={() => router.back()} />
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <Text style={styles.summary}>
          Only what this reply changed. To undo it, use Restore on the desktop.
        </Text>
        {(changes?.files ?? []).map((file) => {
          const { name, dir } = splitPath(file.relative);
          return (
            <Pressable
              key={file.relative}
              accessibilityRole="button"
              accessibilityLabel={`${file.relative}, ${file.additions} added, ${file.deletions} removed`}
              onPress={() =>
                router.push({ pathname: "/diff", params: { id: keepDiff(file) } })
              }
              style={styles.row}
            >
              <View style={styles.names}>
                <Text style={styles.name} numberOfLines={1}>
                  {name}
                </Text>
                {dir ? (
                  <Text style={styles.dir} numberOfLines={1}>
                    {dir}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.count, { color: colors.additions }]}>
                +{formatCount(file.additions)}
              </Text>
              <Text style={[styles.count, { color: colors.deletions }]}>
                -{formatCount(file.deletions)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </>
  );
}

const useStyles = themedStyles((colors) => ({
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 2 },
  summary: { color: colors.muted, fontSize: 13, lineHeight: 18, marginVertical: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
  },
  names: { flex: 1, minWidth: 0 },
  name: { color: colors.content, fontSize: 15 },
  dir: { color: colors.muted, fontSize: 12, marginTop: 1 },
  count: { fontSize: 13, fontVariant: ["tabular-nums"] },
}));
