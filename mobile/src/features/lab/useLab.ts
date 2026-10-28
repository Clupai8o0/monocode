import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "@/features/connection/ConnectionProvider";
import { callLab, errorText } from "./labModel";
import type { LabParams, LabPhoneMethod, LabStatus } from "./types";

/** Only a phone paired with a host's code talks to the lab; never a desktop. */
export function useHostPairing() {
  const { pairing } = useConnection();
  return !!pairing?.desktop.host;
}

/**
 * The host's lab status. Undefined while asked; null when this is not a host
 * pairing or the host can't answer (an older host, or no lab).
 */
export function useLabAvailable() {
  const { command, connected } = useConnection();
  const host = useHostPairing();
  const [status, setStatus] = useState<LabStatus | null | undefined>();
  const asked = host && connected;
  useEffect(() => {
    if (!asked) return;
    let disposed = false;
    callLab(command, "lab.status", {})
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch(() => {
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [command, asked]);
  return asked ? status : null;
}

/** The lab page's state: the status, what is running, and the last error. */
export function useLab() {
  const { command } = useConnection();
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
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
    ) => {
      setBusy(key);
      setError(null);
      try {
        const next = await callLab(command, method, params);
        if (mounted.current) setStatus(next);
        return true;
      } catch (reason) {
        if (mounted.current) setError(errorText(reason));
        return false;
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [command],
  );
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await run("refresh", "lab.status", {});
    if (mounted.current) setRefreshing(false);
  }, [run]);
  // The first look sets state only once the host answers.
  useEffect(() => {
    callLab(command, "lab.status", {})
      .then((next) => {
        if (mounted.current) setStatus(next);
      })
      .catch((reason) => {
        if (mounted.current) setError(errorText(reason));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [command]);
  return { status, error, busy, refreshing, loading, run, refresh };
}
