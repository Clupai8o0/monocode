import { BottomSheet, RNHostView } from "@expo/ui";
import { Text, View } from "react-native";

import type { TurnMetrics } from "@/features/workspace/types";
import { withAlpha, themedStyles } from "@/ui/theme";

import {
  formatClockTime,
  turnMetricsSheet,
  type MetricStat,
} from "./transcriptFormat";

/**
 * The Android metrics sheet: the same rates and token counts as iOS's, in
 * React Native views, as `@expo/ui/swift-ui` has no Android implementation.
 * Rows sit apart by space alone, with no lines between them.
 */
export function TurnMetricsSheet({
  isPresented,
  onDismiss,
  metrics,
  elapsedMs,
  completedAt,
}: {
  isPresented: boolean;
  onDismiss: () => void;
  metrics: TurnMetrics;
  elapsedMs: number | null;
  completedAt?: number;
}) {
  const styles = useStyles();
  const { highlights, tokens } = turnMetricsSheet(metrics, elapsedMs);
  return (
    <BottomSheet isPresented={isPresented} onDismiss={onDismiss} contentPadding={0}>
      <RNHostView matchContents={{ vertical: true }}>
        <View style={styles.body}>
          <View>
            <Text style={styles.title}>Turn metrics</Text>
            {completedAt != null ? (
              <Text style={styles.subtitle}>
                {`Finished at ${formatClockTime(completedAt)}`}
              </Text>
            ) : null}
          </View>
          {highlights.length > 0 ? <StatGroup stats={highlights} /> : null}
          {tokens.length > 0 ? <StatGroup title="Tokens" stats={tokens} /> : null}
        </View>
      </RNHostView>
    </BottomSheet>
  );
}

/** Stats as rows in one rounded card, under an optional heading. */
function StatGroup({ title, stats }: { title?: string; stats: MetricStat[] }) {
  const styles = useStyles();
  return (
    <View style={styles.group}>
      {title ? <Text style={styles.heading}>{title}</Text> : null}
      <View style={styles.card}>
        {stats.map((stat) => (
          <View key={stat.label} style={styles.row}>
            <Text style={styles.label}>{stat.label}</Text>
            <Text style={styles.value}>
              {stat.unit === "%"
                ? `${stat.value}%`
                : stat.unit
                  ? `${stat.value} ${stat.unit}`
                  : stat.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  body: {
    paddingTop: 28,
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 20,
  },
  title: {
    color: colors.content,
    fontSize: 20,
    fontWeight: "600",
  },
  subtitle: {
    marginTop: 2,
    color: colors.muted,
    fontSize: 15,
  },
  group: {
    gap: 8,
  },
  heading: {
    paddingLeft: 4,
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  card: {
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: withAlpha(colors.content, 0.07),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  label: {
    color: colors.muted,
    fontSize: 16,
  },
  value: {
    color: colors.content,
    fontSize: 16,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
}));
