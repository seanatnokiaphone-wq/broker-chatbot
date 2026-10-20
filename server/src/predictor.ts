type Publisher = { publish: (topic: string, payload: string) => unknown };
import type { Store } from "./store.js";

/**
 * Baseline network-drift predictor. Every 5 s, for each <area>/network branch that has latency_ms, it
 * combines three signals into a drift risk:
 *
 * - Early warning: jitter, packet loss and retransmits rising (and throughput falling) against their robust
 *   baseline over the last 30 minutes (median and MAD z-scores, last 30 s).
 * - Rhythm: past drift onsets in the last hour give a typical period, so it knows when the next one is due.
 * - Trend: the latency slope over the last 90 s, projected 2 minutes ahead.
 *
 * It publishes the result to <area>/network/prediction, so it is recorded, charted and searchable like any
 * other topic, and it scores itself: how far ahead each drift was flagged, drifts it missed and false alarms.
 */

const DRIFT_MS = 5000; // latency above this counts as drifting
const WARN_RISK = 0.6;

interface AreaState {
  drifting: boolean;
  warnedAt: number | null;
  onsets: number[];
  leads: number[];
  missed: number;
  falseAlarms: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const r = (v: number, dp = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

export function startPredictor(store: Store, client: Publisher) {
  const areas = new Map<string, AreaState>();

  const robustZ = (topic: string, now: number, sign = 1) => {
    const hist = store.values(topic, now - 30 * 60_000, now).map((v) => v.value);
    const recent = store.values(topic, now - 30_000, now).map((v) => v.value);
    if (hist.length < 20 || !recent.length) return 0;
    const med = median(hist);
    const mad = median(hist.map((x) => Math.abs(x - med))) * 1.4826 || 1e-6;
    return (sign * (mean(recent) - med)) / mad;
  };

  const tick = () => {
    const now = Date.now();
    for (const t of store.topics.values()) {
      if (!t.topic.endsWith("/network/latency_ms")) continue;
      const base = t.topic.slice(0, -"/latency_ms".length);
      let st = areas.get(base);
      if (!st) areas.set(base, (st = { drifting: false, warnedAt: null, onsets: [], leads: [], missed: 0, falseAlarms: 0 }));

      const lat = store.values(t.topic, now - 60 * 60_000, now);
      if (lat.length < 10) continue;
      const last30 = lat.filter((v) => v.ts > now - 30_000).map((v) => v.value);
      const lat30 = mean(last30);

      // Past onsets in the last hour: the 15 s rolling mean crossing DRIFT_MS upward, at least 3 minutes apart.
      const histOnsets: number[] = [];
      let win: number[] = [];
      let above = false;
      for (const v of lat) {
        win.push(v.value);
        if (win.length > 15) win.shift();
        const m = mean(win);
        if (!above && m > DRIFT_MS && (!histOnsets.length || v.ts - histOnsets.at(-1)! > 180_000)) histOnsets.push(v.ts);
        above = m > DRIFT_MS;
      }
      const periods = histOnsets.slice(1).map((o, i) => o - histOnsets[i]).filter((p) => p > 180_000);
      const period = periods.length ? median(periods) : null;
      let nextOnset: number | null = null;
      if (period && histOnsets.length) {
        nextOnset = histOnsets.at(-1)! + period;
        while (nextOnset < now - 60_000) nextOnset += period;
      }
      const dueIn = nextOnset != null ? (nextOnset - now) / 1000 : null;

      // Early-warning signals.
      const z = {
        jitter: robustZ(`${base}/jitter_ms`, now),
        packet_loss: robustZ(`${base}/packet_loss_pct`, now),
        retransmits: robustZ(`${base}/retransmits_per_min`, now),
        throughput_drop: robustZ(`${base}/throughput_mbps`, now, -1),
      };
      const zs = Object.values(z).filter((x) => x > 0).sort((a, b) => b - a);
      const pre = zs.length ? mean(zs.slice(0, 3)) : 0;
      const pPre = logistic((pre - 3) * 1.2);

      // Latency trend over 90 s, projected 2 minutes ahead.
      const tr = lat.filter((v) => v.ts > now - 90_000);
      let slope = 0;
      if (tr.length > 5 && tr.at(-1)!.ts - tr[0].ts > 60_000) {
        const mx = mean(tr.map((v) => v.ts)), my = mean(tr.map((v) => v.value));
        const num = tr.reduce((a, v) => a + (v.ts - mx) * (v.value - my), 0);
        const den = tr.reduce((a, v) => a + (v.ts - mx) ** 2, 0) || 1;
        slope = (num / den) * 1000; // ms per second
      }
      const projected = lat30 + slope * 120;
      const pTrend = logistic((projected - DRIFT_MS) / 600);
      const pRhythm = dueIn == null ? 0.05 : dueIn < -60 ? 0.05 : 0.75 * Math.exp(-Math.max(0, dueIn - 30) / 90);

      const drifting = lat30 > DRIFT_MS;
      const risk = drifting ? 1 : 1 - (1 - pPre) * (1 - pTrend) * (1 - pRhythm);
      const baseline = median(lat.filter((v) => v.value < DRIFT_MS).map((v) => v.value));
      const forecast = drifting ? Math.max(lat30, 8500) : baseline * (1 - risk) + 9000 * risk;

      // Score the predictor against what actually happened.
      if (!st.drifting && drifting) {
        st.onsets.push(now);
        if (st.warnedAt && now - st.warnedAt < 10 * 60_000) st.leads.push((now - st.warnedAt) / 1000);
        else st.missed++;
        st.warnedAt = null;
      } else if (!drifting && risk >= WARN_RISK && !st.warnedAt) st.warnedAt = now;
      else if (!drifting && st.warnedAt && now - st.warnedAt > 6 * 60_000) {
        st.falseAlarms++;
        st.warnedAt = null;
      }
      st.drifting = drifting;

      const reasons: string[] = [];
      if (drifting) reasons.push(`latency ${Math.round(lat30)} ms is above ${DRIFT_MS} ms`);
      for (const [k, v] of Object.entries(z)) if (v > 2.5) reasons.push(`${k.replace("_", " ")} ${v.toFixed(1)}σ above normal`);
      if (!drifting && pTrend > 0.4) reasons.push(`latency rising ${Math.round(slope)} ms/s`);
      if (dueIn != null && dueIn < 180 && dueIn > -60) reasons.push(`drifts recur every ~${Math.round(period! / 60_000)} min, next due ${dueIn > 0 ? `in ${Math.round(dueIn)} s` : "now"}`);

      const doc = {
        status: drifting ? "Drifting" : risk >= WARN_RISK ? "Drift likely" : risk >= 0.3 ? "Watch" : "Normal",
        drift_risk_pct: r(risk * 100, 1),
        latency_now_ms: r(lat30),
        forecast_2m_ms: r(forecast),
        next_drift_due_s: dueIn != null ? r(Math.max(0, dueIn)) : -1,
        typical_period_min: period ? r(period / 60_000, 1) : -1,
        signals: { early_warning_z: r(pre, 2), latency_slope_ms_per_s: r(slope, 1), rhythm_pct: r(pRhythm * 100, 1) },
        reason: reasons.join("; ") || "all signals normal",
        score: {
          drifts_seen: st.onsets.length,
          predicted: st.leads.length,
          missed: st.missed,
          false_alarms: st.falseAlarms,
          median_lead_s: st.leads.length ? r(median(st.leads)) : -1,
          last_lead_s: st.leads.length ? r(st.leads.at(-1)!) : -1,
        },
        model: "baseline-v1",
      };
      client.publish(`${base}/prediction`, JSON.stringify({ ...doc, timestamp: new Date(now).toISOString() }));
    }
  };

  const timer = setInterval(tick, 5000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
