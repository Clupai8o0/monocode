import { router, Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { CodeHeaderTitle, HeaderBlur, HeaderButton } from "@/features/files/codeScreen";
import type {
  ExternalSessionState,
  ExternalTranscriptPage,
  ExternalTurn,
} from "@/features/workspace/types";
import { themedStyles, useColors } from "@/ui/theme";

import { useConnectionKey } from "./ElsewhereSessions";
import { readExternalSession, sourceLabel, stateLabel } from "./externalSessions";
import { Markdown } from "./Markdown";

type Shown = {
  turns: ExternalTurn[];
  before?: number;
  handoff?: ExternalTranscriptPage["handoff"];
  truncated: boolean;
};

/**
 * A session MonoCode did not start, to read only: its handoff file first,
 * then its turns oldest first, with older ones loaded from the top.
 */
export function ElsewhereScreen({
  projectId,
  sessionId,
  name,
  source,
  state,
}: {
  projectId: string;
  sessionId: string;
  name?: string;
  source?: string;
  state?: string;
}) {
  const styles = useStyles();
  const colors = useColors();
  const { command } = useConnection();
  const connection = useConnectionKey();
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  // Bumped by each load, so an older page asked for before it is dropped.
  const generation = useRef(0);
  const loading = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    generation.current += 1;
    loading.current = true;
    const mine = generation.current;
    try {
      const page = await readExternalSession(command, connection, projectId, sessionId);
      if (!alive.current) return;
      setShown({
        turns: page.turns,
        before: page.before,
        handoff: page.handoff,
        truncated: !!page.truncated,
      });
      setError(null);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === mine) loading.current = false;
    }
  }, [command, connection, projectId, sessionId]);

  useEffect(() => {
    // The first read; its state lands after the request, not in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    await load();
    if (alive.current) setRetrying(false);
  };

  const loadOlder = async () => {
    if (!shown || shown.before === undefined || loadingOlder || loading.current) return;
    const before = shown.before;
    const mine = generation.current;
    setLoadingOlder(true);
    try {
      const page = await readExternalSession(
        command,
        connection,
        projectId,
        sessionId,
        before,
      );
      if (!alive.current) return;
      // A refresh since replaced the turns; this page no longer joins them.
      if (generation.current !== mine) return;
      setShown((current) =>
        current && current.before === before
          ? {
              ...current,
              turns: [...page.turns, ...current.turns],
              before: page.before,
              truncated: current.truncated || !!page.truncated,
            }
          : current,
      );
    } catch {
      // The button stays; another tap tries again.
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  };

  const sub = [sourceLabel(source ?? "claude") ?? "claude", state && stateLabel(state as ExternalSessionState)]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <GestureHandlerRootView style={styles.root}>
      <Stack.Screen
        options={{
          headerTitle: () => <CodeHeaderTitle name={name || sessionId}>{sub}</CodeHeaderTitle>,
          headerLeft: () => (
            <HeaderButton icon="close" label="Close" onPress={() => router.back()} />
          ),
        }}
      />
      {shown ? (
        <ScrollView
          style={styles.root}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          }
        >
          {error ? (
            <Text style={styles.note} numberOfLines={2}>
              {error}
            </Text>
          ) : null}
          {shown.before !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void loadOlder()}
              style={({ pressed }) => [styles.older, pressed && styles.pressed]}
            >
              {loadingOlder ? (
                <ActivityIndicator color={colors.muted} />
              ) : (
                <Text style={styles.olderLabel}>Load older</Text>
              )}
            </Pressable>
          ) : null}
          {shown.handoff ? (
            <View style={styles.handoff}>
              <Text style={styles.label}>{shown.handoff.path}</Text>
              <Markdown text={shown.handoff.text} />
            </View>
          ) : null}
          {shown.turns.map((turn, index) => (
            <TurnView key={index} turn={turn} />
          ))}
          {shown.turns.length === 0 && !shown.handoff ? (
            <Text style={styles.note}>Nothing to show yet.</Text>
          ) : null}
          {shown.truncated ? (
            <Text style={styles.note}>Some long text was cut short.</Text>
          ) : null}
        </ScrollView>
      ) : error ? (
        <View style={[styles.center, styles.failed]}>
          <Text style={styles.note}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={retrying}
            onPress={() => void retry()}
            style={({ pressed }) => [styles.older, pressed && styles.pressed]}
          >
            {retrying ? (
              <ActivityIndicator color={colors.muted} />
            ) : (
              <Text style={styles.olderLabel}>Try again</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
      <HeaderBlur color={colors.sheet} />
    </GestureHandlerRootView>
  );
}

function TurnView({ turn }: { turn: ExternalTurn }) {
  const styles = useStyles();
  if (turn.role === "tool") {
    return (
      <Text style={styles.tool} numberOfLines={1}>
        {turn.text}
      </Text>
    );
  }
  if (turn.role === "user") {
    return (
      <View style={styles.bubble}>
        <Text style={styles.userText}>{turn.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      <Markdown text={turn.text} />
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  root: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  failed: {
    gap: 14,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 14,
  },
  older: {
    alignSelf: "center",
    minHeight: 30,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 15,
    backgroundColor: colors.fill,
  },
  olderLabel: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.6,
  },
  handoff: {
    gap: 6,
    paddingBottom: 12,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: colors.bubble,
  },
  userText: {
    color: colors.content,
    fontSize: 16,
  },
  assistant: {},
  tool: {
    color: colors.faint,
    fontSize: 13,
  },
  note: {
    color: colors.muted,
    fontSize: 14,
  },
}));
