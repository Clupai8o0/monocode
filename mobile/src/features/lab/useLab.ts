import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { callLab, errorText } from "./labModel";
import type { LabParams, LabPhoneMethod, LabStatus } from "./types";

/** Only a phone paired with a host's code talks to the lab; never a desktop. */
export function useHostPairing() {
  const { pairing } = useConnection();
  return !!pairing?.desktop.host;
}

/** Which host the phone talks to now; lab state belongs to one host. */
function usePairingKey() {
  const { pairing } = useConnection();
  return pairing
    ? `${pairing.desktop.deviceId}|${pairing.desktop.host?.url ?? ""}`
    : "";
}

/**
 * The host's lab status. Undefined while asked; null when this is not a host
 * pairing or the host can't answer (an older host, or no lab).
 */
export function useLabAvailable() {
  const { command, connected } = useConnection();
  const host = useHostPairing();
  const pairingKey = usePairingKey();
  const [answer, setAnswer] = useState<{
    key: string;
    status: LabStatus | null;
  }>();
  const asked = host && connected;
  useEffect(() => {
    if (!asked) return;
    let disposed = false;
    callLab(command, "lab.status", {})
      .then((value) => {
        if (!disposed) setAnswer({ key: pairingKey, status: value });
      })
      .catch(() => {
        if (!disposed) setAnswer({ key: pairingKey, status: null });
      });
    return () => {
      disposed = true;
    };
  }, [command, asked, pairingKey]);
  if (!asked) return null;
  // Another host's answer is no answer yet.
  return answer?.key === pairingKey ? answer.status : undefined;
}

/** The lab page's state: the status, what is running, and the last error. */
export function useLab() {
  const { command } = useConnection();
  const pairingKey = usePairingKey();
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  // The call running now, so a second one can't start beside it.
  const inFlight = useRef<string | null>(null);
  // Only the newest call's answer may set the status.
  const sequence = useRef(0);
  // The newest status, readable right after run() resolves.
  const latest = useRef<LabStatus | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <M extends LabPhoneMethod>(
      key: string,
      method: M,
      params: LabParams[M],
    ): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = key;
      const mine = ++sequence.current;
      setBusy(key);
      setError(null);
      try {
        const next = await callLab(command, method, params);
        if (mounted.current && mine === sequence.current) {
          latest.current = next;
          setStatus(next);
        }
        return mine === sequence.current;
      } catch (reason) {
        if (mounted.current && mine === sequence.current) {
          setError(errorText(reason));
        }
        return false;
      } finally {
        if (inFlight.current === key && mine === sequence.current) {
          inFlight.current = null;
          if (mounted.current) setBusy(null);
        }
      }
    },
    [command],
  );
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    setRefreshing(true);
    await run("refresh", "lab.status", {});
    if (mounted.current) setRefreshing(false);
  }, [run]);
  // A new host: drop the old one's state while it is asked again.
  const [shownKey, setShownKey] = useState(pairingKey);
  if (shownKey !== pairingKey) {
    setShownKey(pairingKey);
    setStatus(null);
    setError(null);
    setBusy(null);
    setLoading(true);
  }
  // The first look, and again for each new host; the old host's state goes.
  useEffect(() => {
    const mine = ++sequence.current;
    inFlight.current = "load";
    latest.current = null;
    callLab(command, "lab.status", {})
      .then((next) => {
        if (mounted.current && mine === sequence.current) {
          latest.current = next;
          setStatus(next);
        }
      })
      .catch((reason) => {
        if (mounted.current && mine === sequence.current) {
          setError(errorText(reason));
        }
      })
      .finally(() => {
        if (mine !== sequence.current) return;
        inFlight.current = null;
        if (mounted.current) setLoading(false);
      });
  }, [command, pairingKey]);
  return { status, latest, error, busy, refreshing, loading, run, refresh };
}
