import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useConnection } from "@/features/connection/ConnectionProvider";
import type { ExternalSession } from "@/features/workspace/types";
import { Icon } from "@/ui/Icon";
import { themedStyles, useColors } from "@/ui/theme";

import {
  ExternalUnsupported,
  listExternalSessions,
  metaParts,
  sessionTitle,
  stateLabel,
} from "./externalSessions";

const POLL_MS = 20_000;
const PULSE_MS = 1600;
const NONE: ExternalSession[] = [];

/** The connection's key, for remembering one that can't list these. */
export function useConnectionKey() {
  const { pairing } = useConnection();
  return pairing?.desktop.fingerprint ?? "none";
}

/**
 * The project's sessions MonoCode did not start, read when the page comes
 * into view and every 20 s while it stays. The last good list stays on an
 * error; an older desktop or host hides the section.
 */
export function useExternalSessions(projectId: string, active: boolean) {
  const { command } = useConnection();
  const connection = useConnectionKey();
  // Kept with the project and connection they came from, so another's never shows.
  const scope = `${connection}\n${projectId}`;
  const [listed, setListed] = useState<{ scope: string; sessions: ExternalSession[] }>();
  const setSessions = (sessions: ExternalSession[]) => setListed({ scope, sessions });
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await listExternalSessions(command, connection, projectId);
        if (!disposed) setSessions(value);
      } catch (error) {
        if (error instanceof ExternalUnsupported) {
          if (!disposed) setSessions([]);
        }
        // Otherwise keep the last good list.
      }
      if (!disposed) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, connection, projectId, active]);
  return listed?.scope === scope ? listed.sessions : NONE;
}

/** "Elsewhere": a heading, then one row per session. Nothing when empty. */
export function ElsewhereSessions({ sessions }: { sessions: ExternalSession[] }) {
  const styles = useStyles();
  if (sessions.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Elsewhere</Text>
      {sessions.map((session) => (
        <ElsewhereRow key={session.id} session={session} />
      ))}
    </View>
  );
}

function ElsewhereRow({ session }: { session: ExternalSession }) {
  const styles = useStyles();
  const meta = metaParts(session).join("  ·  ");
  const title = sessionTitle(session);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${stateLabel(session.state)}. Read`}
      onPress={() =>
        router.push({
          pathname: "/project/[projectId]/elsewhere/[sessionId]",
          params: {
            projectId: session.projectId,
            sessionId: session.id,
            name: title,
            source: session.source,
            state: session.state,
          },
        })
      }
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.line}>
        <View style={styles.mark}>
          <StateMark state={session.state} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {session.note ? (
        <Text style={styles.note} numberOfLines={1}>
          {session.note}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Running: a soft pulsing green dot. Idle: grey. Handed over: a note icon. */
export function StateMark({ state }: { state: ExternalSession["state"] }) {
  const colors = useColors();
  const styles = useStyles();
  if (state === "handed-over") return <Icon name="note" size={13} color={colors.muted} />;
  if (state === "idle") return <View style={[styles.dot, { backgroundColor: colors.faint }]} />;
  return <PulsingDot />;
}

function PulsingDot() {
  const styles = useStyles();
  const colors = useColors();
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.set(
      withRepeat(
        withTiming(1, { duration: PULSE_MS, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  }, [pulse]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.45 + 0.55 * pulse.get(),
    transform: [{ scale: 0.85 + 0.15 * pulse.get() }],
  }));
  return <Animated.View style={[styles.dot, { backgroundColor: colors.additions }, style]} />;
}

const useStyles = themedStyles((colors) => ({
  section: {
    paddingTop: 28,
  },
  heading: {
    paddingHorizontal: 14,
    paddingBottom: 6,
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 3,
    borderRadius: 14,
  },
  pressed: {
    backgroundColor: colors.selection,
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  mark: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  title: {
    flex: 1,
    color: colors.content,
    fontSize: 15,
    fontWeight: "600",
  },
  meta: {
    maxWidth: "50%",
    color: colors.faint,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  note: {
    paddingLeft: 22,
    color: colors.muted,
    fontSize: 13,
  },
}));
