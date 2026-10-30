import { MONO } from "@/features/changes/diffTheme";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";

import {
  accountsLine,
  ago,
  callsLine,
  choiceLine,
  fingerprintText,
  rdpAddress,
  rdpLink,
  rdpOpenUrls,
  relayLine,
  SCOPE_CHOICES,
  scopeStamp,
  uresourcedActions,
  uresourcedState,
} from "@/features/lab/labModel";
import { useLab } from "@/features/lab/useLab";
import type { LabStatus } from "@/features/lab/types";
import { openFirst } from "@/features/settings/pushSetup";
import { SettingsPage, SettingsRow } from "@/features/settings/SettingsUI";
import { Icon } from "@/ui/Icon";
import { radii, themedStyles, useColors } from "@/ui/theme";

// The home lab, as the host sees it: where Remote Control starts, the relay
// between accounts, uresourced, and the laptop's remote desktop. Each block
// shows only when the host has it.
export default function LabScreen() {
  const colors = useColors();
  const styles = useStyles();
  const lab = useLab();
  if (lab.loading && !lab.status) {
    return (
      <SettingsPage>
        <ActivityIndicator style={styles.loading} color={colors.muted} />
      </SettingsPage>
    );
  }
  const status = lab.status;
  return (
    <SettingsPage
      onRefresh={() => void lab.refresh()}
      refreshing={lab.refreshing}
    >
      {status ? (
        <>
          <Text style={styles.lead}>{status.machine}</Text>
          {lab.error ? <Text style={styles.error}>{lab.error}</Text> : null}
          <RemoteControlBlock status={status} lab={lab} />
          <RelayBlock status={status} lab={lab} />
          <UresourcedBlock status={status} lab={lab} />
          <RemoteDesktopBlock status={status} lab={lab} />
        </>
      ) : (
        <>
          <Text style={styles.lead}>The host did not answer.</Text>
          {lab.error ? <Text style={styles.error}>{lab.error}</Text> : null}
        </>
      )}
    </SettingsPage>
  );
}

type Lab = ReturnType<typeof useLab>;
type BlockProps = { status: LabStatus; lab: Lab };

function RemoteControlBlock({ status, lab }: BlockProps) {
  const colors = useColors();
  const styles = useStyles();
  const scope = status.remoteControl.desired.scope;
  // Set when the host kept a newer choice than the one tapped.
  const [overruled, setOverruled] = useState(false);
  const choose = async (chosen: typeof scope) => {
    setOverruled(false);
    const ok = await lab.run(`scope:${chosen}`, "lab.remoteControl.set", {
      scope: chosen,
      updatedAt: scopeStamp(status),
    });
    if (ok)
      setOverruled(lab.latest.current?.remoteControl.desired.scope !== chosen);
  };
  return (
    <>
      <Text style={styles.heading}>Remote Control</Text>
      <View style={styles.card}>
        {SCOPE_CHOICES.map((choice) => (
          <SettingsRow
            key={choice.scope}
            label={choice.label}
            showChevron={false}
            accessibilityRole="radio"
            accessibilityState={{ checked: choice.scope === scope }}
            onPress={() => {
              if (choice.scope === scope || lab.busy) return;
              void choose(choice.scope);
            }}
            accessory={
              lab.busy === `scope:${choice.scope}` ? (
                <ActivityIndicator color={colors.muted} />
              ) : choice.scope === scope ? (
                <Icon name="check" size={18} color={colors.accent} />
              ) : null
            }
          />
        ))}
      </View>
      {overruled ? (
        <Text style={styles.warning}>A newer choice was kept.</Text>
      ) : null}
      <Text style={styles.note}>{choiceLine(status)}</Text>
      <Text style={styles.note}>
        Lab machines keep it on either way. A Mac picks up the choice while
        MonoCode runs on it.
      </Text>
      {status.remoteControl.machines.map((machine) => (
        <View key={machine.machine} style={styles.line}>
          <Text style={styles.lineTitle}>
            {machine.machine}
            {machine.lab ? " (lab)" : ""}
          </Text>
          <Text style={styles.lineText}>
            {accountsLine(machine.accounts)}, {ago(machine.reportedAt)}
          </Text>
        </View>
      ))}
    </>
  );
}

function RelayBlock({ status, lab }: BlockProps) {
  const colors = useColors();
  const styles = useStyles();
  const relay = status.relay;
  const toggle = (enabled: boolean) => {
    if (lab.busy) return;
    void lab.run("relay", "lab.relay.set", { enabled });
  };
  return (
    <>
      <Text style={styles.heading}>Relay</Text>
      <View style={styles.card}>
        <SettingsRow
          icon="chat"
          label="Messages between accounts"
          onPress={() => toggle(!relay.enabled)}
          accessory={
            lab.busy === "relay" ? (
              <ActivityIndicator color={colors.muted} />
            ) : (
              <Switch
                accessibilityLabel="Relay"
                value={relay.enabled}
                onValueChange={toggle}
                trackColor={{ true: colors.accent }}
              />
            )
          }
        />
      </View>
      <Text style={styles.note}>
        {relay.enabled
          ? relayLine(status)
          : "Off. Sessions on other machines can't message each other."}
      </Text>
      {relay.enabled
        ? relay.peers.map((peer) => (
            <View key={peer.id} style={styles.line}>
              <Text style={styles.lineTitle}>{peer.name}</Text>
              <Text style={styles.lineText}>
                {peer.sessions === 1
                  ? "1 session"
                  : `${peer.sessions} sessions`}
                , seen {ago(peer.lastSeen)}
              </Text>
            </View>
          ))
        : null}
    </>
  );
}

function UresourcedBlock({ status, lab }: BlockProps) {
  const styles = useStyles();
  const [confirm, setConfirm] = useState(false);
  const value = status.uresourced;
  if (!value) return null;
  const calls = callsLine(value);
  const actions = uresourcedActions(value);
  return (
    <>
      <Text style={styles.heading}>uresourced</Text>
      <View style={[styles.card, styles.padded]}>
        <Text style={styles.state}>{uresourcedState(value)}</Text>
        {value.since && value.active ? (
          <Text style={styles.lineText}>Started {ago(value.since)}</Text>
        ) : null}
        {calls ? <Text style={styles.lineText}>{calls}</Text> : null}
        {value.looping ? (
          <Text style={styles.warning}>
            It looks stuck in a loop with systemd. Turning it off stops that.
          </Text>
        ) : null}
        {value.installed ? (
          <View style={styles.buttons}>
            <Button
              label="Check now"
              busy={lab.busy === "probe"}
              onPress={() =>
                void lab.run("probe", "lab.status", { probe: true })
              }
              disabled={!!lab.busy}
            />
            {actions.on ? (
              <Button
                label="Turn on"
                busy={lab.busy === "on"}
                onPress={() =>
                  void lab.run("on", "lab.uresourced.set", { action: "on" })
                }
                disabled={!!lab.busy}
              />
            ) : null}
            {actions.restart ? (
              <Button
                label="Restart"
                busy={lab.busy === "restart"}
                onPress={() =>
                  void lab.run("restart", "lab.uresourced.set", {
                    action: "restart",
                  })
                }
                disabled={!!lab.busy}
              />
            ) : null}
            {actions.off ? (
              <Button
                label="Turn off"
                destructive
                onPress={() => setConfirm(true)}
                disabled={!!lab.busy || confirm}
              />
            ) : null}
          </View>
        ) : null}
        {confirm && actions.off ? (
          <View style={styles.confirm}>
            <Text style={styles.lineText}>
              Stop it and keep it from starting again?
            </Text>
            <View style={styles.buttons}>
              <Button
                label="Turn off"
                destructive
                busy={lab.busy === "off"}
                disabled={!!lab.busy}
                onPress={() =>
                  void lab
                    .run("off", "lab.uresourced.set", { action: "off" })
                    .then((ok) => {
                      if (ok) setConfirm(false);
                    })
                }
              />
              <Button
                label="Cancel"
                disabled={lab.busy === "off"}
                onPress={() => setConfirm(false)}
              />
            </View>
          </View>
        ) : null}
      </View>
    </>
  );
}

function RemoteDesktopBlock({ status, lab }: BlockProps) {
  const colors = useColors();
  const styles = useStyles();
  const [copied, setCopied] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [badLink, setBadLink] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const desktop = status.remoteDesktop;
  if (!desktop) return null;
  const address = rdpAddress(status);
  const toggle = (enabled: boolean) => {
    if (lab.busy) return;
    void lab.run("rdp", "lab.remoteDesktop.set", { enabled });
  };
  const copy = async (which: string, text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(which);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1500);
  };
  const open = async () => {
    // Never the host's own uri: the link is built here from checked parts.
    const link = rdpLink(desktop);
    setBadLink(!link);
    if (!link) return;
    if (address) await Clipboard.setStringAsync(address);
    setMissing(!(await openFirst(rdpOpenUrls(link))));
  };
  return (
    <>
      <Text style={styles.heading}>Remote desktop</Text>
      {desktop.installed ? (
        <View style={styles.card}>
          <SettingsRow
            icon="computer"
            label="Remote desktop"
            onPress={() => toggle(!desktop.running)}
            accessory={
              lab.busy === "rdp" ? (
                <ActivityIndicator color={colors.muted} />
              ) : (
                <Switch
                  accessibilityLabel="Remote desktop"
                  value={desktop.running}
                  onValueChange={toggle}
                  trackColor={{ true: colors.accent }}
                />
              )
            }
          />
        </View>
      ) : (
        <Text style={styles.note}>
          krdpserver is not installed on the host.
        </Text>
      )}
      {desktop.lanExposed ? (
        <Text style={styles.warning}>
          It can be reached from the local network too, not only over Tailscale.
        </Text>
      ) : null}
      {!desktop.address ? (
        <Text style={styles.warning}>Tailscale is down on the host.</Text>
      ) : null}
      {address ? (
        <View style={[styles.card, styles.gap]}>
          <SettingsRow
            label="Address"
            value={address}
            showChevron={false}
            onPress={() => void copy("address", address)}
            accessory={
              <Icon
                name={copied === "address" ? "check" : "copy"}
                size={18}
                color={copied === "address" ? colors.accent : colors.faint}
              />
            }
          />
          <SettingsRow
            label="Username"
            value={desktop.username}
            showChevron={false}
            onPress={() => void copy("username", desktop.username)}
            accessory={
              <Icon
                name={copied === "username" ? "check" : "copy"}
                size={18}
                color={copied === "username" ? colors.accent : colors.faint}
              />
            }
          />
        </View>
      ) : null}
      <Text style={styles.note}>
        Sign in with the Linux user&apos;s own password.
      </Text>
      {desktop.certificate.sha256 ? (
        <Text style={styles.mono} selectable>
          Certificate {fingerprintText(desktop.certificate.sha256)}
        </Text>
      ) : null}
      {desktop.running && address ? (
        <View style={[styles.card, styles.gap]}>
          <SettingsRow
            icon="computer"
            label="Open"
            showChevron={false}
            onPress={() => void open()}
          />
        </View>
      ) : null}
      {desktop.running && address && badLink ? (
        <Text style={styles.warning}>
          The host sent an address or username that doesn&apos;t look right, so
          nothing was opened.
        </Text>
      ) : null}
      {copied ? <Text style={styles.note}>Copied.</Text> : null}
      {desktop.running && address ? (
        <Text style={styles.note}>
          {missing
            ? "No Remote Desktop app opened. Get Microsoft's from the store."
            : "Copies the address, then opens Microsoft's Remote Desktop app."}
        </Text>
      ) : null}
    </>
  );
}

function Button({
  label,
  onPress,
  busy,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}): ReactNode {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.muted} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            { color: destructive ? colors.deletions : colors.accent },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const useStyles = themedStyles((colors) => ({
  loading: {
    marginTop: 40,
  },
  lead: {
    color: colors.content,
    fontSize: 17,
    fontWeight: "600",
    marginHorizontal: 16,
  },
  heading: {
    color: colors.muted,
    fontSize: 15,
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderCurve: "continuous",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  padded: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 4,
  },
  gap: {
    marginTop: 12,
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
    marginHorizontal: 16,
  },
  warning: {
    color: colors.deletions,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    marginHorizontal: 16,
  },
  mono: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: MONO,
    marginTop: 8,
    marginHorizontal: 16,
  },
  line: {
    marginTop: 12,
    marginHorizontal: 16,
    gap: 2,
  },
  lineTitle: {
    color: colors.content,
    fontSize: 15,
  },
  lineText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  state: {
    color: colors.content,
    fontSize: 17,
    fontWeight: "600",
  },
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  button: {
    minHeight: 40,
    minWidth: 88,
    paddingHorizontal: 14,
    borderRadius: radii.row,
    backgroundColor: colors.sheet,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.6,
  },
  confirm: {
    marginTop: 12,
  },
  error: {
    color: colors.deletions,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 16,
    marginHorizontal: 16,
  },
}));
