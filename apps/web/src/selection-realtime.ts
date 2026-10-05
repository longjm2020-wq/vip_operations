import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { queryClient as rootQueryClient } from "./api";

/** The stream carries invalidations only; data still comes from authorized sync. */
export function useSelectionRealtime(
  client: QueryClient,
  tableId: string | undefined,
  onAccessLost: () => void,
) {
  const [connected, setConnected] = useState(false);
  const lost = useRef(onAccessLost);
  lost.current = onAccessLost;
  useEffect(() => {
    let stream: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let revoked = false;
    let pending = false;
    let permissions = false;
    let running = false;
    const drain = async () => {
      timer = undefined;
      if (stopped || revoked || running) return;
      running = true;
      try {
        while (pending && !stopped && !revoked) {
          pending = false;
          const rights = permissions;
          permissions = false;
          // A notification received during a fetch schedules another read, so a
          // write committed after that snapshot cannot be lost or cancel it.
          await Promise.all([
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
    const refresh = (rights = false) => {
      pending = true;
      permissions ||= rights;
      if (!timer && !running) timer = setTimeout(() => void drain(), 80);
    };
    const close = () => {
      stream?.close();
      stream = undefined;
      setConnected(false);
    };
    const open = () => {
      if (document.hidden || stream || stopped || revoked) return;
      stream = new EventSource(
        `/api/v1/style-selections/events${tableId ? `?tableId=${encodeURIComponent(tableId)}` : ""}`,
      );
      stream.addEventListener("ready", () => {
        setConnected(true);
        refresh(true);
      });
      stream.addEventListener("refresh", (event) => {
        let rights = false;
        try {
          rights =
            JSON.parse((event as MessageEvent).data).permissions === true;
        } catch {
          /* Re-fetch without accepting any event content. */
        }
        refresh(rights);
      });
      stream.addEventListener("access-revoked", () => {
        revoked = true;
        close();
        lost.current();
        void rootQueryClient.invalidateQueries({ queryKey: ["me"] });
      });
      stream.onerror = () => setConnected(false); // EventSource retries; polling covers interruptions.
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
