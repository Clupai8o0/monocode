import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";

import {
  ntfyStoreUrls,
  ntfySubscribeLink,
} from "@/features/settings/ntfyLink";
import { openFirst, usePushConfig } from "@/features/settings/pushSetup";
import { SettingsPage, SettingsRow } from "@/features/settings/SettingsUI";
import { Icon } from "@/ui/Icon";
import { radii, themedStyles, useColors } from "@/ui/theme";

// Pushes with the app closed, through the ntfy app subscribed to this host's
// topic. One tap subscribes; without ntfy installed, the store and the two
// values to type in by hand.
export default function PushScreen() {
  const colors = useColors();
  const styles = useStyles();
  const config = usePushConfig();
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState<"server" | "topic" | null>(null);
  const link = config ? ntfySubscribeLink(config) : null;
  const subscribe = async () => {
    if (!link) return;
    setMissing(!(await openFirst([link])));
  };
  const copy = async (which: "server" | "topic", text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(which);
  };
  if (config === undefined) {
    return (
      <SettingsPage>
        <ActivityIndicator style={styles.loading} color={colors.muted} />
      </SettingsPage>
    );
  }
  if (!config || !link) {
    return (
      <SettingsPage>
        <Text style={styles.lead}>Not set up on this host.</Text>
        <Text style={styles.note}>
          On the host, run monocode-host notify with your ntfy server&apos;s
          address, then open this page again.
        </Text>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage>
      <Text style={styles.lead}>Set up on this host.</Text>
      <Text style={styles.note}>
        Subscribe in the ntfy app to hear when a session is done, failed,
        stopped or needs you, even with MonoCode closed.
      </Text>
      <View style={[styles.card, styles.gap]}>
        <SettingsRow
          icon="notifications"
          label="Subscribe in ntfy"
          showChevron={false}
          onPress={() => void subscribe()}
        />
      </View>
      {missing ? (
        <>
          <Text style={styles.note}>
            The ntfy app isn&apos;t installed. Get it, then tap Subscribe again,
            or add the server and topic in it by hand.
          </Text>
          <View style={[styles.card, styles.gap]}>
            <SettingsRow
              icon="add"
              label="Get ntfy"
              showChevron={false}
              onPress={() => void openFirst(ntfyStoreUrls(Platform.OS))}
            />
          </View>
        </>
      ) : null}
      <View style={[styles.card, styles.gap]}>
        <SettingsRow
          icon="copy"
          label="Copy server"
          value={config.server.replace(/^https?:\/\//, "")}
          showChevron={false}
          accessory={
            copied === "server" ? (
              <Icon name="check" size={18} color={colors.accent} />
            ) : undefined
          }
          onPress={() => void copy("server", config.server)}
        />
        <SettingsRow
          icon="copy"
          label="Copy topic"
          showChevron={false}
          accessory={
            copied === "topic" ? (
              <Icon name="check" size={18} color={colors.accent} />
            ) : undefined
          }
          onPress={() => void copy("topic", config.topic)}
        />
      </View>
      <Text style={styles.note}>
        The topic is a secret: anyone with it can read these pushes.
      </Text>
    </SettingsPage>
  );
}

const useStyles = themedStyles((colors) => ({
  loading: {
    marginTop: 32,
  },
  lead: {
    color: colors.content,
    fontSize: 17,
    fontWeight: "600",
    marginTop: 8,
    marginHorizontal: 16,
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
    marginHorizontal: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderCurve: "continuous",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  gap: {
    marginTop: 20,
  },
}));
