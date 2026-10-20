/**
 * Statistical process control on recorded history: X̄-R, X̄-S and individuals/moving-range (I-MR) charts with
 * control limits, Western Electric rules and process capability (Cp, Cpk, Pp, Ppk) against spec limits.
 */

export type SpcChart = "xbar-r" | "xbar-s" | "imr";

export interface SpcSpec {
  lsl?: number;
  usl?: number;
  target?: number;
  /** Readings at or below this are ignored (e.g. 0 g while the filler is stopped). */
  validAbove?: number;
}

export interface SpcOptions extends SpcSpec {
  chart?: SpcChart;
  /** Subgroup size for X̄ charts (2-10). */
  n?: number;
  /** Seconds between subgroups (X̄ charts) or between individual readings (I-MR). */
  every?: number;
}

/** Known spec limits by tag name. Anything else gets control limits only. */
export const SPC_SPECS: Record<string, SpcSpec> = {
  fill_weight: { lsl: 495, target: 500, usl: 505, validAbove: 100 },
};
export const specFor = (topic: string): SpcSpec => SPC_SPECS[topic.split("/").pop()!] ?? {};

// Control chart constants by subgroup size.
const K: Record<number, { A2: number; D3: number; D4: number; d2: number; A3: number; B3: number; B4: number; c4: number }> = {
  2: { A2: 1.88, D3: 0, D4: 3.267, d2: 1.128, A3: 2.659, B3: 0, B4: 3.267, c4: 0.7979 },
  3: { A2: 1.023, D3: 0, D4: 2.574, d2: 1.693, A3: 1.954, B3: 0, B4: 2.568, c4: 0.8862 },
  4: { A2: 0.729, D3: 0, D4: 2.282, d2: 2.059, A3: 1.628, B3: 0, B4: 2.266, c4: 0.9213 },
  5: { A2: 0.577, D3: 0, D4: 2.114, d2: 2.326, A3: 1.427, B3: 0, B4: 2.089, c4: 0.94 },
  6: { A2: 0.483, D3: 0, D4: 2.004, d2: 2.534, A3: 1.287, B3: 0.03, B4: 1.97, c4: 0.9515 },
  7: { A2: 0.419, D3: 0.076, D4: 1.924, d2: 2.704, A3: 1.182, B3: 0.118, B4: 1.882, c4: 0.9594 },
  8: { A2: 0.373, D3: 0.136, D4: 1.864, d2: 2.847, A3: 1.099, B3: 0.185, B4: 1.815, c4: 0.965 },
  9: { A2: 0.337, D3: 0.184, D4: 1.816, d2: 2.97, A3: 1.032, B3: 0.239, B4: 1.761, c4: 0.9693 },
  10: { A2: 0.308, D3: 0.223, D4: 1.777, d2: 3.078, A3: 0.975, B3: 0.284, B4: 1.716, c4: 0.9727 },
};

export const RULES: Record<number, string> = {
  1: "1 point beyond 3σ",
  2: "2 of 3 points beyond 2σ, same side",
  3: "4 of 5 points beyond 1σ, same side",
  4: "8 points in a row on one side of the centre line",
  5: "6 points in a row steadily rising or falling",
  6: "Range/spread above its upper control limit",
};

export interface SpcPoint {
  ts: number;
  /** Subgroup mean, or the individual reading for I-MR. */
  x: number;
  /** Range, standard deviation or moving range; null for the first I-MR point. */
  r: number | null;
  rules: number[];
}

export interface SpcResult {
  chart: SpcChart;
  n: number;
  every: number;
  points: SpcPoint[];
  x: { cl: number; ucl: number; lcl: number; sigma: number };
  r: { cl: number; ucl: number; lcl: number; label: string };
  capability: {
    mean: number;
    sigmaWithin: number;
    sigmaOverall: number;
    cp: number | null;
    cpk: number | null;
    pp: number | null;
    ppk: number | null;
    outOfSpecPct: number | null;
    readings: number;
  };
  spec: SpcSpec;
  violations: { ts: number; rule: number; text: string }[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

/** Western Electric rules 1-5 on a series against a centre line and sigma. Returns the rules each point triggers. */
function weRules(xs: number[], cl: number, s: number): number[][] {
  const out = xs.map(() => [] as number[]);
  const z = xs.map((x) => (x - cl) / (s || 1e-9));
  for (let i = 0; i < z.length; i++) {
    if (Math.abs(z[i]) > 3) out[i].push(1);
    for (const side of [1, -1]) {
      const beyond = (k: number, lim: number) => z.slice(Math.max(0, i - k + 1), i + 1).filter((v) => side * v > lim).length;
      if (i >= 2 && side * z[i] > 2 && beyond(3, 2) >= 2) out[i].push(2);
      if (i >= 4 && side * z[i] > 1 && beyond(5, 1) >= 4) out[i].push(3);
      if (i >= 7 && beyond(8, 0) === 8) out[i].push(4);
    }
    if (i >= 5) {
      const d = xs.slice(i - 5, i + 1).map((v, j, a) => (j ? Math.sign(v - a[j - 1]) : 0)).slice(1);
      if (d.every((v) => v > 0) || d.every((v) => v < 0)) out[i].push(5);
    }
  }
  return out.map((r) => [...new Set(r)]);
}

/** Builds an SPC chart from time-ordered readings. Returns null when there are too few readings. */
export function spc(rows: { ts: number; value: number }[], opts: SpcOptions = {}): SpcResult | null {
  const chart = opts.chart ?? "xbar-r";
  const n = Math.min(10, Math.max(2, Math.round(opts.n ?? 5)));
  const every = Math.max(1, opts.every ?? (chart === "imr" ? 10 : 60)) * 1000;
  const spec: SpcSpec = { lsl: opts.lsl, usl: opts.usl, target: opts.target, validAbove: opts.validAbove };
  const valid = rows.filter((r) => Number.isFinite(r.value) && (spec.validAbove == null || r.value > spec.validAbove));
  if (valid.length < 10) return null;

  // Rational subgroups: the first n readings in each `every` interval (or one reading per interval for I-MR).
  const groups: { ts: number; xs: number[] }[] = [];
  for (const r of valid) {
    const slot = Math.floor(r.ts / every) * every;
    const g = groups.at(-1);
    if (g && g.ts === slot) {
      if (chart !== "imr" && g.xs.length < n) g.xs.push(r.value);
    } else groups.push({ ts: slot, xs: [r.value] });
  }
  const used = chart === "imr" ? groups : groups.filter((g) => g.xs.length === n);
  if (used.length < (chart === "imr" ? 10 : 5)) return null;

  let points: SpcPoint[];
  let x: SpcResult["x"], rr: SpcResult["r"], sigmaWithin: number;
  if (chart === "imr") {
    const xs = used.map((g) => g.xs[0]);
    const mrs = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
    const mrBar = mean(mrs), xBar = mean(xs);
    sigmaWithin = mrBar / 1.128;
    x = { cl: xBar, ucl: xBar + 3 * sigmaWithin, lcl: xBar - 3 * sigmaWithin, sigma: sigmaWithin };
    rr = { cl: mrBar, ucl: 3.267 * mrBar, lcl: 0, label: "MR" };
    points = used.map((g, i) => ({ ts: g.ts, x: xs[i], r: i ? mrs[i - 1] : null, rules: [] }));
  } else {
    const k = K[n];
    const means = used.map((g) => mean(g.xs));
    const spread = used.map((g) => (chart === "xbar-s" ? sd(g.xs) : Math.max(...g.xs) - Math.min(...g.xs)));
    const xBar = mean(means), sBar = mean(spread);
    sigmaWithin = chart === "xbar-s" ? sBar / k.c4 : sBar / k.d2;
    const half = (chart === "xbar-s" ? k.A3 : k.A2) * sBar;
    x = { cl: xBar, ucl: xBar + half, lcl: xBar - half, sigma: half / 3 };
    rr = chart === "xbar-s" ? { cl: sBar, ucl: k.B4 * sBar, lcl: k.B3 * sBar, label: "S" } : { cl: sBar, ucl: k.D4 * sBar, lcl: k.D3 * sBar, label: "R" };
    points = used.map((g, i) => ({ ts: g.ts, x: means[i], r: spread[i], rules: [] }));
  }

  const fired = weRules(points.map((p) => p.x), x.cl, x.sigma);
  points.forEach((p, i) => {
    p.rules = fired[i];
    if (p.r != null && p.r > rr.ucl) p.rules.push(6);
  });
  const violations = points.flatMap((p) => p.rules.map((rule) => ({ ts: p.ts, rule, text: RULES[rule] })));

  const all = valid.map((r) => r.value);
  const m = mean(all), sAll = sd(all);
  const { lsl, usl } = spec;
  const capIdx = (s: number) => ({
    p: lsl != null && usl != null ? (usl - lsl) / (6 * s) : null,
    pk: lsl != null || usl != null ? Math.min(usl != null ? (usl - m) / (3 * s) : Infinity, lsl != null ? (m - lsl) / (3 * s) : Infinity) : null,
  });
  const within = capIdx(sigmaWithin), overall = capIdx(sAll);
  const out = lsl != null || usl != null ? all.filter((v) => (lsl != null && v < lsl) || (usl != null && v > usl)).length : null;

  return {
    chart,
    n: chart === "imr" ? 1 : n,
    every: every / 1000,
    points,
    x,
    r: rr,
    capability: {
      mean: m,
      sigmaWithin,
      sigmaOverall: sAll,
      cp: within.p,
      cpk: within.pk,
      pp: overall.p,
      ppk: overall.pk,
      outOfSpecPct: out == null ? null : (out / all.length) * 100,
      readings: all.length,
    },
    spec,
    violations,
  };
}
