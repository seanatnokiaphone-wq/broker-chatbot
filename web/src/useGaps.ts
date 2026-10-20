import { useEffect, useState } from "react";
import { getGaps, type Gaps } from "./api";

/** Sequence-number gaps for a seq topic over a window; refreshes every 5 s while live. */
export function useGaps(seqTopic: string | null, from: number, to: number, live: boolean) {
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const span = to - from;
  useEffect(() => {
    if (!seqTopic) return setGaps(null);
    let cancelled = false;
    const load = () => {
      const end = live ? Date.now() : to;
      getGaps(seqTopic, end - span, end).then((g) => !cancelled && setGaps(g)).catch(() => {});
    };
    load();
    const timer = live ? setInterval(load, 5000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [seqTopic, live ? 0 : from, live ? 0 : to, live, span]);
  return gaps;
}
