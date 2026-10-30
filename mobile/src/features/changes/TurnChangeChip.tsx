import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text } from "react-native";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { sessionIdFromRoute } from "@/features/sessions/externalSessions";
import { themedStyles, withAlpha, useColors } from "@/ui/theme";

import { formatCount } from "./diffTheme";
import { keepTurn, type TurnChanges } from "./shownTurns";

// Recorded changes never change, so each turn is read once.
const read = new Map<string, TurnChanges>();

export function turnChipText(changes: TurnChanges): string {
  const count = changes.files.length;
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * "3 files +42 -7" under a turn, as on the desktop. Opens a read-only list of
 * what that one reply changed; restoring stays on the desktop.
 */
export function TurnChangeChip({ turnId }: { turnId: string }) {
  const styles = useStyles();
  const colors = useColors();
  const { command } = useConnection();
  const { sessionId: routeId } = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = routeId ? sessionIdFromRoute(routeId) : undefined;
  const [changes, setChanges] = useState(() => read.get(turnId));

  useEffect(() => {
    if (!sessionId || read.has(turnId)) return;
    let live = true;
    command<TurnChanges>("session.turnChanges", {
      conversationId: sessionId,
      turnId,
    })
      .then((next) => {
        read.set(turnId, next);
        if (live) setChanges(next);
      })
      // An older desktop, or a turn still recording: no chip is the right answer.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [command, sessionId, turnId]);

  if (!changes || changes.files.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`This turn's changes: ${turnChipText(changes)}, ${changes.additions} added, ${changes.deletions} removed`}
      onPress={() =>
        router.push({ pathname: "/turn", params: { id: keepTurn(changes) } })
      }
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: withAlpha(colors.content, pressed ? 0.12 : 0.06) },
      ]}
    >
      <Text style={styles.count}>{turnChipText(changes)}</Text>
      <Text style={[styles.count, { color: colors.additions }]}>
        +{formatCount(changes.additions)}
      </Text>
      <Text style={[styles.count, { color: colors.deletions }]}>
        -{formatCount(changes.deletions)}
      </Text>
    </Pressable>
  );
}


const useStyles = themedStyles((colors) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: 28,
    marginTop: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  count: {
    color: withAlpha(colors.content, 0.65),
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
}));
