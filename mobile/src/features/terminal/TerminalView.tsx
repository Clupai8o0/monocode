import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
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
import { themedStyles, useColors } from "@/ui/theme";

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
  const { width, height } = useWindowDimensions();
  const cols = Math.max(20, Math.floor((width - PADDING * 2) / CHAR_WIDTH));
  const rows = Math.max(10, Math.floor(height / (FONT_SIZE * 1.4)));
  const { text, started, alive, exitCode, error, send, restart } = useTerminal(
    projectId,
    worktreePath,
    { cols, rows },
  );
  const [input, setInput] = useState("");
  const scroll = useRef<ScrollView>(null);
  // Follow new output only while the end is in view, so scrolling back holds.
  const following = useRef(true);

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
          following.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (following.current) scroll.current?.scrollToEnd({ animated: false });
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text selectable style={styles.text}>
          {text.lines.join("\n")}
        </Text>
        {started && !alive ? (
          <Text style={styles.status}>
            {`The shell exited${exitCode ? ` with code ${exitCode}` : ""}.`}
          </Text>
        ) : null}
      </ScrollView>

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
