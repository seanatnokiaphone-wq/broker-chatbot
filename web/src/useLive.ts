import { useEffect, useRef, useState } from "react";
import type { TopicRow } from "./api";

export interface Live {
  topics: Map<string, TopicRow>;
  /** Topics updated in the last push, with the time they arrived. */
  pulses: Map<string, number>;
  mps: { ts: number; v: number }[];
  connected: boolean;
  version: number;
}

/** Subscribes to the server's live feed of topic updates. */
export function useLive(): Live {
  const topics = useRef(new Map<string, TopicRow>());
  const pulses = useRef(new Map<string, number>());
  const mps = useRef<{ ts: number; v: number }[]>([]);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as { type: string; topics: TopicRow[]; mps: number; ts: number };
        if (msg.type === "snapshot") topics.current = new Map();
        const now = Date.now();
        for (const t of msg.topics) {
          topics.current.set(t.topic, t);
          if (msg.type === "update") pulses.current.set(t.topic, now);
        }
        mps.current = [...mps.current, { ts: msg.ts, v: msg.mps }].slice(-120);
        setVersion((v) => v + 1);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, []);

  return { topics: topics.current, pulses: pulses.current, mps: mps.current, connected, version };
}
