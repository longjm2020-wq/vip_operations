import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { queryClient as rootQueryClient } from "./api";

/** The stream carries invalidations only; data still comes from authorized sync. */
export function useSelectionRealtime(
  client: QueryClient,
  tableId: string | undefined,
  onAccessLost: () => void,
  onFieldsChanged: () => Promise<void>,
) {
  const [connected, setConnected] = useState(false);
  const lost = useRef(onAccessLost);
  lost.current = onAccessLost;
  const fieldsChanged = useRef(onFieldsChanged);
  fieldsChanged.current = onFieldsChanged;
  useEffect(() => {
    let stream: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let revoked = false;
    let pending = false;
    let permissions = false;
    let fields = false;
    let running = false;
    const drain = async () => {
      timer = undefined;
      if (stopped || revoked || running) return;
      running = true;
      try {
        while (pending && !stopped && !revoked) {
          pending = false;
          const rights = permissions;
          const definitions = fields;
          permissions = fields = false;
          // A notification received during a fetch schedules another read, so a
          // write committed after that snapshot cannot be lost or cancel it.
          await Promise.all([
            ...(definitions ? [fieldsChanged.current()] : []),
            client.invalidateQueries(
              { queryKey: ["style-selections"] },
              { cancelRefetch: false },
            ),
            client.invalidateQueries(
              { queryKey: ["style-selection-style-counts"] },
              { cancelRefetch: false },
            ),
            client.invalidateQueries(
              { queryKey: ["selection-shared-view"] },
              { cancelRefetch: false },
            ),
            ...(rights
              ? [
                  client.invalidateQueries(
                    { queryKey: ["selection-protection"] },
                    { cancelRefetch: false },
                  ),
                  rootQueryClient.invalidateQueries(
                    { queryKey: ["me"] },
                    { cancelRefetch: false },
                  ),
                ]
              : []),
          ]);
        }
      } finally {
        running = false;
      }
    };
    const refresh = (rights = false, definitions = false) => {
      pending = true;
      permissions ||= rights;
      fields ||= definitions || rights;
      if (!timer && !running) timer = setTimeout(() => void drain(), 80);
    };
    const close = () => {
      clearTimeout(reconnectTimer);
      stream?.close();
      stream = undefined;
      setConnected(false);
    };
    const open = () => {
      if (document.hidden || stream || stopped || revoked) return;
      const source = (stream = new EventSource(
        `/api/v1/style-selections/events${tableId ? `?tableId=${encodeURIComponent(tableId)}` : ""}`,
      ));
      stream.addEventListener("ready", () => {
        if (stream !== source) return;
        setConnected(true);
        refresh(true);
      });
      stream.addEventListener("refresh", (event) => {
        if (stream !== source) return;
        let rights = false;
        let definitions = false;
        try {
          rights =
            JSON.parse((event as MessageEvent).data).permissions === true;
          definitions =
            JSON.parse((event as MessageEvent).data).fields === true;
        } catch {
          /* Re-fetch without accepting any event content. */
        }
        refresh(rights, definitions);
      });
      stream.addEventListener("access-revoked", () => {
        if (stream !== source) return;
        revoked = true;
        close();
        lost.current();
        void rootQueryClient.invalidateQueries({ queryKey: ["me"] });
      });
      stream.onerror = () => {
        if (stream !== source) return;
        setConnected(false);
        // A rolling release may briefly return 404/503. Browsers permanently
        // close those streams; explicitly retry as well as native reconnects.
        if (source.readyState === EventSource.CLOSED) {
          close();
          if (!stopped && !revoked && !document.hidden)
            reconnectTimer = setTimeout(open, 3000);
        }
      };
    };
    const visibility = () => {
      if (document.hidden) close();
      else {
        open();
        refresh(true);
      }
    };
    const offline = () => close();
    open();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", offline);
    return () => {
      stopped = true;
      clearTimeout(timer);
      close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", offline);
    };
  }, [client, tableId]);
  return connected;
}
