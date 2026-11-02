import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSpc, type Spc, type SpcChartType } from "../api";

const CHARTS: { id: SpcChartType; label: string }[] = [
  { id: "xbar-r", label: "X̄-R" },
  { id: "xbar-s", label: "X̄-S" },
  { id: "imr", label: "I-MR" },
];
const RULE_SHORT: Record<number, string> = { 1: "beyond 3σ", 2: "2 of 3 beyond 2σ", 3: "4 of 5 beyond 1σ", 4: "8 on one side", 5: "6 trending", 6: "spread above UCL" };
const LIMIT = "#e66767";
const axis = { stroke: "#383835", tick: { fill: "#898781", fontSize: 10 } };
const tip = { contentStyle: { background: "#1a1a19", border: "1px solid #383835", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#c3c2b7" }, itemStyle: { color: "#f0efec" } };
const f = (v: number | null | undefined, dp = 2) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(dp));
const capClass = (v: number | null) => (v == null ? "" : v >= 1.33 ? "good" : v >= 1 ? "warn" : "bad");

/** SPC chart for a numeric topic: X̄ (or individuals) with control limits and rule violations, the spread chart, and capability. */
export function SpcChart({ topic, from, to, live, unit }: { topic: string; from: number; to: number; live: boolean; unit?: string }) {
  const [chart, setChart] = useState<SpcChartType>("xbar-r");
  const [spc, setSpc] = useState<Spc | null | undefined>(undefined);
  const span = to - from;
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const end = live ? Date.now() : to;
      getSpc(topic, end - span, end, chart).then((s) => !cancelled && setSpc(s)).catch(() => {});
    };
    load();
    const timer = live ? setInterval(load, 5000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [topic, chart, live ? 0 : from, live ? 0 : to, live, span]);

  const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const pick = (
    <div className="segmented mini">
      {CHARTS.map((c) => (
        <button key={c.id} className={chart === c.id ? "on" : ""} onClick={() => setChart(c.id)}>
          {c.label}
        </button>
      ))}
    </div>
  );
  if (spc === undefined) return <div className="spc">{pick}</div>;
  if (!spc) return <div className="spc">{pick}<div className="small muted">Not enough readings in this window for SPC.</div></div>;

  const xs = spc.points.map((p) => p.x);
  const pad = (spc.x.ucl - spc.x.lcl) * 0.15;
  const xDomain = [Math.min(spc.x.lcl, ...xs) - pad, Math.max(spc.x.ucl, ...xs) + pad];
  const rs = spc.points.map((p) => p.r ?? 0);
  const fired = [...new Set(spc.violations.map((v) => v.rule))].sort();
  const c = spc.capability;
  const dot = (props: { cx?: number; cy?: number; payload?: Spc["points"][number]; index?: number }) => {
    const bad = !!props.payload?.rules.length;
    return <circle key={props.index} cx={props.cx} cy={props.cy} r={bad ? 3.2 : 1.8} fill={bad ? LIMIT : "#3987e5"} stroke="none" />;
  };
  const limits = (l: { cl: number; ucl: number; lcl: number }, lcl = true) => [
    <ReferenceLine key="u" y={l.ucl} stroke={LIMIT} strokeDasharray="4 3" ifOverflow="extendDomain" />,
    <ReferenceLine key="c" y={l.cl} stroke="#898781" strokeDasharray="2 3" />,
    lcl && l.lcl > 0 ? <ReferenceLine key="l" y={l.lcl} stroke={LIMIT} strokeDasharray="4 3" ifOverflow="extendDomain" /> : null,
  ];
  const label = spc.chart === "imr" ? "Individuals" : `X̄ (n=${spc.n}, every ${spc.every} s)`;

  return (
    <div className="spc">
      <div className="spc-head">
        {pick}
        <span
          className={`small ${spc.violations.length ? "bad" : "good"}`}
          title={`${fired.map((r) => `Rule ${r}: ${RULE_SHORT[r]}`).join("\n")}\n\nLatest:\n${spc.violations.slice(-6).map((v) => `${new Date(v.ts).toLocaleTimeString()}: rule ${v.rule}`).join("\n")}`}
        >
          {spc.violations.length ? `⚠ ${spc.violations.length} signal${spc.violations.length === 1 ? "" : "s"} · rule${fired.length > 1 ? "s" : ""} ${fired.join(", ")}` : "✓ In control"}
        </span>
      </div>
      <div className="chart-unit">
        {label} · UCL {f(spc.x.ucl)} · CL {f(spc.x.cl)} · LCL {f(spc.x.lcl)}
        {unit ? ` ${unit}` : ""}
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={spc.points} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#2c2c2a" vertical={false} />
          <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} tickFormatter={time} {...axis} minTickGap={40} />
          <YAxis width={44} domain={xDomain} tickFormatter={(v) => Number(v).toFixed(1)} {...axis} />
          <Tooltip {...tip} labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()} formatter={(v, _n, item) => {
            const rules = (item.payload as Spc["points"][number]).rules;
            return [`${Number(v).toFixed(2)}${unit ? ` ${unit}` : ""}${rules.length ? ` · ${rules.map((r) => RULE_SHORT[r]).join(", ")}` : ""}`, spc.chart === "imr" ? "x" : "x̄"];
          }} />
          {limits(spc.x)}
          <Line dataKey="x" stroke="#3987e5" strokeWidth={1.4} dot={dot} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="chart-unit">
        {spc.r.label} · UCL {f(spc.r.ucl)} · R̄ {f(spc.r.cl)}
      </div>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={spc.points.map((p, i) => ({ ts: p.ts, r: rs[i], bad: p.rules.includes(6) }))} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} hide />
          <YAxis width={44} domain={[0, Math.max(spc.r.ucl * 1.15, ...rs)]} tickFormatter={(v) => Number(v).toFixed(1)} {...axis} tickCount={3} />
          <Tooltip {...tip} labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()} formatter={(v) => [Number(v).toFixed(2), spc.r.label]} />
          {limits(spc.r, false)}
          <Line dataKey="r" stroke="#9085e9" strokeWidth={1.2} dot={(p: { cx?: number; cy?: number; payload?: { bad: boolean }; index?: number }) => <circle key={p.index} cx={p.cx} cy={p.cy} r={p.payload?.bad ? 3 : 0} fill={LIMIT} />} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="spc-cap small">
        {spc.spec.lsl != null || spc.spec.usl != null ? (
          <>
            <span title="Spec limits">Spec {f(spc.spec.lsl, 1)}–{f(spc.spec.usl, 1)}{unit ? ` ${unit}` : ""}</span>
            <span className={capClass(c.cp)} title="Potential capability, within-subgroup σ">Cp {f(c.cp)}</span>
            <span className={capClass(c.cpk)} title="Capability allowing for centring, within-subgroup σ">Cpk {f(c.cpk)}</span>
            <span className={capClass(c.ppk)} title="Performance, overall σ">Ppk {f(c.ppk)}</span>
            <span className={c.outOfSpecPct ? "bad" : ""} title="Readings outside the spec limits">{f(c.outOfSpecPct, 2)}% out</span>
          </>
        ) : (
          <span className="muted">No spec limits for this tag: control limits only</span>
        )}
        <span className="muted" title="Mean and within-subgroup σ">
          x̄ {f(c.mean)} · σ {f(c.sigmaWithin, 3)}
        </span>
      </div>
    </div>
  );
}
