import { useState } from "react";
import { Text, View } from "react-native";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { LiquidView } from "@/ui/LiquidView";
import { withAlpha, themedStyles, useColors } from "@/ui/theme";

/** Under a session's header while its agent waits to run a tool: what it
 *  wants to run, and Allow and Deny. A machine's host sends `approval`. */
export function ApprovalBar({ sessionId }: { sessionId: string }) {
  const colors = useColors();
  const styles = useStyles();
  const connection = useConnection();
  const session = connection.catalog.sessions.find((item) => item.id === sessionId);
  // The request answered last, hidden until the next poll drops it.
  const [answered, setAnswered] = useState<number | null>(null);
  const approval = session?.approval;
  if (!approval || approval.requestId === answered) return null;
  const decide = (decision: "allow" | "deny") => {
    setAnswered(approval.requestId);
    connection
      .command("session.approve", {
        conversationId: sessionId,
        requestId: approval.requestId,
        decision,
      })
      .then(() => connection.refresh())
      // Shown again to try once more.
      .catch(() => setAnswered(null));
  };
  return (
    <View style={styles.row}>
      <LiquidView
        tintColor={withAlpha(colors.caution, 0.12)}
        innerStyle={styles.pill}
        style={styles.label}
      >
        <Text style={styles.labelText} numberOfLines={1}>
          {approval.label}
        </Text>
      </LiquidView>
      <LiquidView
        accessibilityLabel={`Allow ${approval.label}`}
        onPress={() => decide("allow")}
        pressedScale={1.04}
        tintColor={withAlpha(colors.additions, 0.16)}
        innerStyle={styles.pill}
      >
        <Text style={[styles.action, { color: colors.additions }]}>Allow</Text>
      </LiquidView>
      <LiquidView
        accessibilityLabel={`Deny ${approval.label}`}
        onPress={() => decide("deny")}
        pressedScale={1.04}
        tintColor={withAlpha(colors.deletions, 0.12)}
        innerStyle={styles.pill}
      >
        <Text style={[styles.action, { color: colors.deletions }]}>Deny</Text>
      </LiquidView>
    </View>
  );
}

const useStyles = themedStyles((colors) => ({
  // Fits the 22pt line under the header.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
  },
  label: {
    flexShrink: 1,
  },
  pill: {
    height: 22,
    paddingHorizontal: 10,
    justifyContent: "center",
  },
  labelText: {
    color: colors.caution,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "600",
  },
  action: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "700",
  },
}));
