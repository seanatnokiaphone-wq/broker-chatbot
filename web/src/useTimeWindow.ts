import { useState } from "react";

const MAX_MS = 180 * 60_000;
const MIN_MS = 60_000;

/**
 * A chart time window that follows "now" until the user zooms or pans, then stays fixed until reset.
 * Zooming keeps the centre; panning moves by a quarter of the window; nothing goes past now or past retention.
 */
export function useTimeWindow(defaultMinutes: number) {
  const [minutes, setMinutesState] = useState(defaultMinutes);
  const [fixed, setFixed] = useState<{ from: number; to: number } | null>(null);
  const now = Date.now();
  const from = fixed ? fixed.from : now - minutes * 60_000;
  const to = fixed ? fixed.to : now;
  const span = to - from;

  const clamp = (f: number, t: number) => {
    const n = Date.now();
    let s = Math.min(MAX_MS, Math.max(MIN_MS, t - f));
    let end = Math.min(n, f + (t - f) / 2 + s / 2);
    let start = end - s;
    if (start < n - MAX_MS) {
      start = n - MAX_MS;
      end = start + s;
    }
    // Back at the live edge with the default width: follow now again.
    if (n - end < 2000 && Math.abs(s - minutes * 60_000) < 1000) return setFixed(null);
    setFixed({ from: start, to: end });
  };

  return {
    from,
    to,
    live: !fixed,
    zoomed: !!fixed,
    minutes,
    setMinutes: (m: number) => (setMinutesState(m), setFixed(null)),
    zoomIn: () => clamp(from + span / 4, to - span / 4),
    zoomOut: () => clamp(from - span / 2, to + span / 2),
    panLeft: () => {
      const s = Math.min(span, MAX_MS);
      const start = Math.max(Date.now() - MAX_MS, from - span / 4);
      setFixed({ from: start, to: start + s });
    },
    panRight: () => {
      const n = Date.now();
      const end = Math.min(n, to + span / 4);
      if (n - end < 2000 && Math.abs(span - minutes * 60_000) < 1000) return setFixed(null);
      setFixed({ from: end - span, to: end });
    },
    zoomTo: (f: number, t: number) => (Math.abs(t - f) >= 5000 ? clamp(Math.min(f, t), Math.max(f, t)) : undefined),
    reset: () => setFixed(null),
  };
}

export type TimeWindow = ReturnType<typeof useTimeWindow>;
