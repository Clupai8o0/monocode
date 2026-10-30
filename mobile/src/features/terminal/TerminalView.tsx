import {
  rememberTerminalScroll,
  restoreTarget,
  savedTerminalScroll,
} from "./terminalScroll";
import * as Haptics from "expo-haptics";
import { useEffect, memo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MONO } from "@/features/changes/diffTheme";
import { Icon } from "@/ui/Icon";
import { themedStyles, useColors, useScheme } from "@/ui/theme";

import {
  runTextStyle,
  TERMINAL_PALETTES,
  type TerminalRun,
} from "./terminalText";

import { useTerminal } from "./useTerminal";

const FONT_SIZE = 12;
/** A monospace glyph's advance at that size, near enough for both platforms. */
const CHAR_WIDTH = FONT_SIZE * 0.6;
const PADDING = 12;

/** Keys a phone keyboard has no way to type. */
const KEYS = [
  { label: "Ctrl-C", data: "\x03", hint: "Stop the running command" },
  { label: "Tab", data: "\t", hint: "Complete" },
  { label: "↑", data: "\x1b[A", hint: "Previous command" },
  { label: "↓", data: "\x1b[B", hint: "Next command" },
  { label: "Esc", data: "\x1b", hint: "Escape" },
  { label: "Ctrl-D", data: "\x04", hint: "End input" },
];

/** One line's runs as spans; unchanged lines keep their array and skip render. */
const Line = memo(function Line({
  runs,
  palette,
  content,
  background,
}: {
  runs: TerminalRun[];
  palette: readonly string[];
  content: string;
  background: string;
}) {
  return runs.map((run, index) =>
    run.style ? (
      <Text
        key={index}
        style={runTextStyle(run.style, palette, { content, background })}
      >
        {run.text}
      </Text>
    ) : (
      run.text
    ),
  );
});

export function TerminalView({
  projectId,
  worktreePath,
  top,
}: {
  projectId: string;
  worktreePath?: string;
  /** Room left for the header over the screen. */
  top: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const palette = TERMINAL_PALETTES[useScheme()];
  const { width, height } = useWindowDimensions();
  const cols = Math.max(20, Math.floor((width - PADDING * 2) / CHAR_WIDTH));
  const rows = Math.max(10, Math.floor(height / (FONT_SIZE * 1.4)));
  const { terminalId, replaying, text, started, alive, exitCode, error, send, restart } =
    useTerminal(projectId, worktreePath, { cols, rows });
  const [input, setInput] = useState("");
  const scroll = useRef<ScrollView>(null);
  // Follow new output only while the end is in view, so scrolling back holds.
  const following = useRef(true);
  const [away, setAway] = useState(false);
  // Where this shell was left, put back as its history comes in again.
  const restoring = useRef<number | null>(null);
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!terminalId || restoredFor.current === terminalId) return;
    restoredFor.current = terminalId;
    restoring.current = savedTerminalScroll(terminalId);
    if (restoring.current === null) return;
    following.current = false;
    scroll.current?.scrollTo({ y: restoring.current, animated: false });
  }, [terminalId]);
  const viewport = useRef(0);
  // All the history is in. If the place is gone, this is as close as it gets.
  useEffect(() => {
    if (replaying || restoring.current === null) return;
    restoring.current = null;
    setAway(true);
  }, [replaying]);

  const submit = () => {
    void send(`${input}\r`);
    setInput("");
  };
  const key = (data: string) => {
    void Haptics.selectionAsync();
    // Completion works on what the shell has, so what is typed goes first.
    if (data === "\t") {
      void send(`${input}\t`);
      setInput("");
    } else void send(data);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <ScrollView
        ref={scroll}
        style={styles.output}
        contentContainerStyle={[styles.outputContent, { paddingTop: top + 8 }]}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          viewport.current = layoutMeasurement.height;
          // The replay's own scrolling isn't the person's.
          if (restoring.current !== null) return;
          following.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
          setAway(!following.current);
          if (terminalId) {
            rememberTerminalScroll(
              terminalId,
              following.current ? null : contentOffset.y,
            );
          }
        }}
        scrollEventThrottle={100}
        onScrollBeginDrag={() => {
          restoring.current = null;
        }}
        onLayout={({ nativeEvent }) => {
          viewport.current = nativeEvent.layout.height;
        }}
        onContentSizeChange={(_width, height) => {
          if (restoring.current !== null) {
            const target = restoreTarget(restoring.current, height, viewport.current);
            scroll.current?.scrollTo({ y: target.y, animated: false });
            if (target.done) {
              restoring.current = null;
              setAway(true);
            }
            return;
          }
          if (following.current) scroll.current?.scrollToEnd({ animated: false });
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.note}>
          Full-screen programs like vim don&apos;t work here.
        </Text>
        <Text selectable style={styles.text}>
          {text.runs.map((runs, index) => (
            <Text key={index}>
              {index ? "\n" : null}
              <Line
                runs={runs}
                palette={palette}
                content={colors.content}
                background={colors.background}
              />
            </Text>
          ))}
        </Text>
        {started && !alive ? (
          <Text style={styles.status}>
            {`The shell exited${exitCode ? ` with code ${exitCode}` : ""}.`}
          </Text>
        ) : null}
      </ScrollView>
      {away ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to the latest output"
          onPress={() => {
            following.current = true;
            setAway(false);
            if (terminalId) rememberTerminalScroll(terminalId, null);
            scroll.current?.scrollToEnd({ animated: true });
          }}
          style={styles.latest}
        >
          <Icon name="chevronDown" size={14} color={colors.background} />
          <Text style={styles.latestLabel}>Latest</Text>
        </Pressable>
      ) : null}

      {error ? (
        <Text style={styles.error} numberOfLines={2}>
          {error}
        </Text>
      ) : null}

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {alive ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={styles.keys}
            >
              {KEYS.map((entry) => (
                <Pressable
                  key={entry.label}
                  accessibilityRole="button"
                  accessibilityLabel={entry.label}
                  accessibilityHint={entry.hint}
                  onPress={() => key(entry.data)}
                  style={({ pressed }) => [styles.key, pressed && styles.pressed]}
                >
                  <Text style={styles.keyLabel}>{entry.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.inputRow}>
              <TextInput
                value={input}
                onChangeText={setInput}
                onSubmitEditing={submit}
                submitBehavior="submit"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                returnKeyType="send"
                placeholder="Command"
                placeholderTextColor={colors.faint}
                accessibilityLabel="Command"
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Run"
                onPress={submit}
                style={({ pressed }) => [styles.send, pressed && styles.pressed]}
              >
                <Icon name="send" size={18} color={colors.inverse} />
              </Pressable>
            </View>
          </>
        ) : started ? (
          <Pressable
            accessibilityRole="button"
            onPress={restart}
            style={({ pressed }) => [styles.restart, pressed && styles.pressed]}
          >
            <Icon name="terminal" size={17} color={colors.content} />
            <Text style={styles.restartLabel}>Start a new shell</Text>
          </Pressable>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const useStyles = themedStyles((colors) => ({
  latest: {
    position: "absolute",
    right: 16,
    bottom: 108,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: colors.content,
  },
  latestLabel: { color: colors.background, fontSize: 13, fontWeight: "600" },
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  output: {
    flex: 1,
  },
  outputContent: {
    paddingHorizontal: PADDING,
    paddingBottom: 12,
  },
  text: {
    fontFamily: MONO,
    fontSize: FONT_SIZE,
    lineHeight: FONT_SIZE * 1.4,
    color: colors.content,
  },
  note: {
    marginBottom: 8,
    fontSize: 12,
    color: colors.faint,
  },
  status: {
    marginTop: 12,
    fontSize: 13,
    color: colors.muted,
  },
  error: {
    paddingHorizontal: PADDING,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.deletions,
  },
  dock: {
    paddingTop: 8,
    gap: 8,
    backgroundColor: colors.sheet,
  },
  keys: {
    paddingHorizontal: PADDING,
    gap: 8,
  },
  key: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  keyLabel: {
    fontFamily: MONO,
    fontSize: 13,
    color: colors.content,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: PADDING,
  },
  input: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.content,
    fontFamily: MONO,
    fontSize: 14,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.content,
  },
  restart: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: PADDING,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  restartLabel: {
    fontSize: 15,
    color: colors.content,
  },
  pressed: {
    opacity: 0.6,
  },
}));
