/**
 * A mock ISA-95 / Unified Namespace plant: enterprise/site/area/line/cell/tag.
 * Each tag is a small generator; lines run a state machine that drives speeds,
 * counters and OEE, and a fault scheduler injects incidents worth asking about.
 */

export type LineState = "Running" | "Idle" | "Down" | "Changeover";

export interface Tag {
  topic: string;
  unit?: string;
  /** Publish period in seconds. */
  every: number;
  retain?: boolean;
  /** Return true to simulate this message getting lost (read() still runs, so sequence numbers move on). */
  drop?: () => boolean;
  /** A number or string is wrapped as {value, unit, quality, timestamp}; an object is published as a nested JSON document. */
  read: (t: number) => number | string | JsonDoc;
}

export type JsonDoc = { [key: string]: string | number | boolean | JsonDoc | JsonDoc[] };

const ENTERPRISE = "acme";
const SITE = "dublin";
const root = `${ENTERPRISE}/${SITE}`;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const noise = (n: number) => (Math.random() - 0.5) * 2 * n;
const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const wave = (t: number, period: number, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);

const shiftOf = () => {
  const h = new Date().getHours();
  return h >= 6 && h < 14 ? "A" : h >= 14 && h < 22 ? "B" : "C";
};

/** First-order lag toward a target, so values move smoothly. */
class Lag {
  constructor(public v: number, private k = 0.15) {}
  step(target: number) {
    this.v += (target - this.v) * this.k;
    return this.v;
  }
}

interface Fault {
  name: string;
  /** e.g. "packaging/line2/filler/motor_temp" — matched by the tag generators. */
  key: string;
  until: number;
}

export class Plant {
  readonly tags: Tag[] = [];
  readonly faults: Fault[] = [];
  readonly lineStates = new Map<string, LineState>();
  private nextFaultAt = Date.now() + 60_000;

  constructor() {
    this.site();
    this.packagingLine("line1", 120, 0);
    this.packagingLine("line2", 100, 1.3);
    this.packagingLine("line3", 150, 2.4);
    this.packagingLine("line4", 90, 3.7);
    this.mixer("mixer1", 0);
    this.mixer("mixer2", 2.1);
    this.oven();
    this.cip();
    this.utilities();
  }

  private add(topic: string, read: Tag["read"], unit?: string, every = 2, retain = false, drop?: Tag["drop"]) {
    this.tags.push({ topic: `${root}/${topic}`, unit, every, retain, read, drop });
  }

  fault(key: string) {
    const now = Date.now();
    return this.faults.find((f) => f.until > now && key.startsWith(f.key));
  }

  /** Called once a second by the publisher. */
  tick(now: number) {
    for (let i = this.faults.length - 1; i >= 0; i--) if (this.faults[i].until < now) this.faults.splice(i, 1);
    if (now >= this.nextFaultAt) {
      const pool: [string, string][] = [
        ["Filler motor overheating", "packaging/line2/filler/motor_temp"],
        ["Line 1 jam at labeler", "packaging/line1/state"],
        ["Compressor 2 trip, air pressure dropping", "utilities/compressed_air/compressor2"],
        ["Oven zone 2 temperature overshoot", "processing/oven1/zone2"],
        ["Mixer 1 high motor current", "processing/mixer1/motor_current"],
        ["Capper torque drift on line 2", "packaging/line2/capper/torque"],
        ["Line 3 filler motor overheating", "packaging/line3/filler/motor_temp"],
        ["Line 4 jam at labeler", "packaging/line4/state"],
      ];
      const [name, key] = pool[Math.floor(Math.random() * pool.length)];
      const until = now + rand(120, 300) * 1000;
      this.faults.push({ name, key, until });
      console.log(`[sim] fault injected: ${name} (${Math.round((until - now) / 1000)} s)`);
      this.nextFaultAt = now + rand(240, 480) * 1000;
    }
  }

  private site() {
    this.add("shift", () => shiftOf(), undefined, 30, true);
    this.add("headcount", () => 42 + Math.round(noise(3)), "people", 60, true);
    this.add("environment/ambient_temp", (t) => round(18 + 3 * wave(t, 3600) + noise(0.2)), "°C", 10);
    this.add("environment/humidity", (t) => round(55 + 8 * wave(t, 5400, 1) + noise(0.5)), "%RH", 10);
  }

  private packagingLine(line: string, ratedBpm: number, phase: number) {
    const base = `packaging/${line}`;
    let state: LineState = "Running";
    let stateUntil = Date.now() + rand(300, 900) * 1000;
    let good = Math.round(rand(10_000, 40_000));
    let reject = Math.round(good * 0.012);
    let running = 0;
    let runSpeed = 0;
    let total = 0;
    let lastT = 0;
    const speed = new Lag(ratedBpm * 0.95);
    const alarm = { text: "" };
    const temp = { filler: new Lag(52), capper: new Lag(46), labeler: new Lag(44), palletizer: new Lag(40) };

    const update = (t: number) => {
      if (t === lastT) return;
      const dt = lastT ? t - lastT : 1;
      lastT = t;
      const now = Date.now();
      const jam = this.fault(`${base}/state`);
      if (jam && state === "Running") {
        state = "Down";
        alarm.text = "E-214 Labeler web break";
        stateUntil = jam.until;
      } else if (now > stateUntil) {
        if (state === "Running") {
          const r = Math.random();
          state = r < 0.5 ? "Idle" : r < 0.8 ? "Down" : "Changeover";
          alarm.text = state === "Down" ? ["E-101 Bottle infeed starved", "E-330 Capper chute blocked", "E-502 Guard door open"][Math.floor(Math.random() * 3)] : "";
          stateUntil = now + rand(30, state === "Changeover" ? 600 : 180) * 1000;
        } else {
          state = "Running";
          alarm.text = "";
          stateUntil = now + rand(600, 1800) * 1000;
        }
      }
      this.lineStates.set(line, state);
      const target = state === "Running" ? ratedBpm * (0.92 + 0.05 * wave(t, 900, phase)) : 0;
      speed.step(target);
      total += dt;
      if (state === "Running") {
        running += dt;
        runSpeed += speed.v * dt;
      }
      const made = (speed.v / 60) * dt;
      const rejectRate = this.fault(`${base}/capper/torque`) ? 0.06 : 0.012;
      good += made * (1 - rejectRate);
      reject += made * rejectRate;
    };
    const s = (fn: Tag["read"]): Tag["read"] => (t) => (update(t), fn(t));
    const runningFactor = () => (state === "Running" ? 1 : 0.2);

    this.add(`${base}/state`, s(() => state), undefined, 2, true);
    this.add(`${base}/alarm/active`, s(() => alarm.text || "none"), undefined, 5, true);
    this.add(`${base}/speed`, s(() => round(speed.v + noise(0.8), 1)), "bpm", 1);
    this.add(`${base}/good_count`, s(() => Math.round(good)), "units", 2);
    this.add(`${base}/reject_count`, s(() => Math.round(reject)), "units", 2);
    const availability = () => (total ? running / total : 1);
    const performance = () => (running ? Math.min(1, runSpeed / (running * ratedBpm)) : 0.95);
    const quality = () => good / (good + reject);
    this.add(`${base}/oee/availability`, s(() => round(availability() * 100, 1)), "%", 10);
    this.add(`${base}/oee/performance`, s(() => round(performance() * 100, 1)), "%", 10);
    this.add(`${base}/oee/quality`, s(() => round(quality() * 100, 1)), "%", 10);
    this.add(`${base}/oee/oee`, s(() => round(availability() * performance() * quality() * 100, 1)), "%", 10);

    const motorTemp = (cell: keyof typeof temp, normal: number) =>
      s((t) => {
        const hot = this.fault(`${base}/${cell}/motor_temp`) ? 38 : 0;
        return round(temp[cell].step(normal * (0.75 + 0.25 * runningFactor()) + hot + 2 * wave(t, 600, phase)) + noise(0.3), 1);
      });

    this.add(`${base}/filler/fill_weight`, s(() => round(state === "Running" ? 500 + noise(2.5) : 0, 1)), "g", 1);
    this.add(`${base}/filler/nozzle_pressure`, s((t) => round(2.4 + 0.1 * wave(t, 120) + noise(0.03), 2)), "bar", 2);
    this.add(`${base}/filler/motor_temp`, motorTemp("filler", 55), "°C", 2);
    this.add(`${base}/filler/motor_current`, s(() => round(12 * runningFactor() + noise(0.4), 1)), "A", 2);

    // Filler counters with a per-message sequence number. Some messages are lost on purpose: about 1% at random,
    // plus a network blip every 8-20 minutes that drops everything for 5-30 s. The counters keep counting and the
    // sequence number keeps incrementing, so the gaps show up as jumps in seq.
    let seq = 0; // restarts from 1 each time the simulator starts, like a real publisher
    let filled = good + reject + rand(500, 2000);
    let fillRejects = filled * 0.004;
    let lastFillT = 0;
    let blipFrom = Date.now() + rand(120, 600) * 1000;
    let blipUntil = 0;
    const lost = () => {
      const now = Date.now();
      if (now >= blipFrom) {
        blipUntil = now + rand(5, 30) * 1000;
        blipFrom = blipUntil + rand(480, 1200) * 1000;
      }
      return now < blipUntil || Math.random() < 0.01;
    };
    this.add(`${base}/filler/counts`, s((t) => {
      const dt = lastFillT ? t - lastFillT : 0;
      lastFillT = t;
      const made = (speed.v / 60) * dt;
      const rr = this.fault(`${base}/filler/motor_temp`) ? 0.02 : 0.004;
      filled += made;
      fillRejects += made * rr;
      const total = Math.round(filled), rejects = Math.round(fillRejects);
      return { seq: ++seq, good_count: total - rejects, reject_count: rejects, total_count: total, state: state === "Running" ? "Filling" : "Stopped" };
    }), undefined, 1, false, lost);

    this.add(`${base}/capper/torque`, s((t) => round((this.fault(`${base}/capper/torque`) ? 1.6 + 0.4 * wave(t, 60) : 2.2) + noise(0.05), 2)), "Nm", 2);
    this.add(`${base}/capper/motor_temp`, motorTemp("capper", 48), "°C", 2);
    this.add(`${base}/capper/cap_hopper_level`, s((t) => round(60 + 35 * wave(t, 1500, phase) + noise(1), 0)), "%", 5);

    this.add(`${base}/labeler/web_tension`, s(() => round(state === "Running" ? 85 + noise(3) : 20 + noise(1), 1)), "N", 2);
    this.add(`${base}/labeler/motor_temp`, motorTemp("labeler", 45), "°C", 2);
    this.add(`${base}/labeler/label_roll_remaining`, s((t) => round(100 - ((t / 20) % 100), 0)), "%", 10);

    this.add(`${base}/palletizer/pallet_count`, s(() => Math.floor(good / 1200)), "pallets", 5);
    this.add(`${base}/palletizer/layer`, s(() => Math.floor((good % 1200) / 150) + 1), undefined, 5);
    this.add(`${base}/palletizer/motor_temp`, motorTemp("palletizer", 42), "°C", 2);

    // Nested JSON: the MES work order running on the line.
    const products = {
      line1: [{ sku: "CL-330", name: "Cola 330ml can" }, { sku: "CL-500", name: "Cola 500ml PET" }],
      line2: [{ sku: "LM-330", name: "Lemon 330ml can" }, { sku: "OR-1L", name: "Orange 1L PET" }],
      line3: [{ sku: "WT-500", name: "Still water 500ml PET" }, { sku: "SP-500", name: "Sparkling water 500ml PET" }],
      line4: [{ sku: "EN-250", name: "Energy 250ml can" }, { sku: "IT-330", name: "Iced tea 330ml glass" }],
    }[line] ?? [{ sku: "GEN-330", name: "Generic 330ml" }];
    let wo = 24100 + Math.floor(rand(0, 50)), woStart = 0, target = 24000, product = products[0], lastState: LineState = state;
    this.add(`${base}/mes/work_order`, s(() => {
      if (!woStart) woStart = good;
      if (lastState === "Changeover" && state !== "Changeover") {
        wo++;
        woStart = good;
        target = [12000, 24000, 36000][Math.floor(Math.random() * 3)];
        product = products[(products.indexOf(product) + 1) % products.length];
      }
      lastState = state;
      const produced = Math.round(good - woStart);
      return {
        order: { id: `WO-${wo}`, status: state === "Changeover" ? "Changeover" : produced >= target ? "Complete" : "In Progress" },
        product: { ...product, batch_size: target },
        progress: { produced, remaining: Math.max(0, target - produced), percent: round(Math.min(100, (produced / target) * 100), 1) },
        operator: { name: ({ line1: "A. Byrne", line2: "C. Murphy", line3: "D. O'Neill", line4: "R. Quinn" } as Record<string, string>)[line] ?? "Unassigned", shift: shiftOf() },
        line_state: state,
      };
    }), undefined, 5, true);

    if (line === "line2") {
      // Nested JSON: the palletizer robot's controller snapshot, three levels deep.
      const axisTemp = [new Lag(38), new Lag(41), new Lag(36)];
      this.add(`${base}/palletizer/robot`, s((t) => ({
        controller: { mode: state === "Running" ? "Auto" : "Manual", program: "P-LAYER-6", cycle_time_s: round(state === "Running" ? 8.4 + noise(0.3) : 0, 2) },
        axes: {
          a1: { temp: { value: round(axisTemp[0].step(38 + 4 * runningFactor() + wave(t, 300)) + noise(0.2), 1), unit: "°C" }, torque_pct: round(45 * runningFactor() + noise(2), 1) },
          a2: { temp: { value: round(axisTemp[1].step(41 + 5 * runningFactor() + wave(t, 360)) + noise(0.2), 1), unit: "°C" }, torque_pct: round(62 * runningFactor() + noise(2), 1) },
          a3: { temp: { value: round(axisTemp[2].step(36 + 3 * runningFactor() + wave(t, 420)) + noise(0.2), 1), unit: "°C" }, torque_pct: round(30 * runningFactor() + noise(2), 1) },
        },
        gripper: { state: state === "Running" ? (t % 8 < 4 ? "Holding" : "Open") : "Open", vacuum_kpa: round(state === "Running" && t % 8 < 4 ? -62 + noise(1.5) : -2 + noise(0.5), 1) },
        safety: { fence_closed: state !== "Down" || !alarm.text.includes("Guard"), estop: false },
      })), undefined, 2);
    }
  }

  private mixer(name: string, phase: number) {
    const recipes = { mixer1: "Syrup base v3", mixer2: "Citrus concentrate v7" } as Record<string, string>;
    const base = `processing/${name}`;
    const phases = ["Charging", "Mixing", "Heating", "Holding", "Discharging", "CIP"];
    const durations = [180, 420, 300, 240, 180, 240];
    const start = Date.now() - rand(0, 1500) * 1000;
    let batch = 2400 + Math.floor(rand(0, 100));
    let lastPhase = -1;
    const temp = new Lag(25, 0.05);
    const level = new Lag(20, 0.05);
    const current = () => {
      const cycle = durations.reduce((a, b) => a + b, 0);
      let x = ((Date.now() - start) / 1000) % cycle;
      let i = 0;
      while (x > durations[i]) x -= durations[i++];
      if (i === 0 && lastPhase !== 0) batch++;
      lastPhase = i;
      return phases[i];
    };
    const rpm = () => ({ Mixing: 180, Heating: 120, Holding: 60, Charging: 30, Discharging: 40, CIP: 90 })[current()] ?? 0;

    this.add(`${base}/state`, () => (current() === "CIP" ? "Cleaning" : "Running"), undefined, 5, true);
    this.add(`${base}/batch/id`, () => (current(), `B-${batch}`), undefined, 10, true);
    this.add(`${base}/batch/phase`, () => current(), undefined, 2, true);
    this.add(`${base}/speed`, () => round(rpm() + noise(2), 0), "rpm", 1);
    this.add(`${base}/motor_current`, () => round(rpm() * 0.09 + (this.fault(`${base}/motor_current`) ? 9 : 0) + noise(0.3), 1), "A", 2);
    this.add(`${base}/motor_temp`, (t) => round(45 + rpm() * 0.05 + 2 * wave(t, 700, phase) + noise(0.3), 1), "°C", 2);
    this.add(`${base}/tank_level`, () => {
      const p = current();
      const target = p === "Charging" ? 85 : p === "Discharging" || p === "CIP" ? 5 : level.v;
      return round(level.step(target) + noise(0.3), 1);
    }, "%", 2);
    this.add(`${base}/product_temp`, () => {
      const p = current();
      const target = p === "Heating" || p === "Holding" ? 72 : p === "CIP" ? 60 : 25;
      return round(temp.step(target) + noise(0.2), 1);
    }, "°C", 2);

    // Nested JSON: the batch record from the batch engine, with setpoints next to actuals.
    this.add(`${base}/batch/record`, () => {
      const p = current();
      const spTemp = p === "Heating" || p === "Holding" ? 72 : p === "CIP" ? 60 : 25;
      return {
        batch: { id: `B-${batch}`, recipe: recipes[name] ?? "Base", phase: p, step: phases.indexOf(p) + 1, of_steps: phases.length },
        setpoints: { temperature: { value: spTemp, unit: "°C" }, speed: { value: rpm(), unit: "rpm" } },
        actuals: { temperature: { value: round(temp.v, 1), unit: "°C" }, speed: { value: round(rpm() + noise(2), 0), unit: "rpm" }, level: { value: round(level.v, 1), unit: "%" } },
        quality: { brix: round(p === "Holding" || p === "Discharging" ? 11.2 + noise(0.15) : 0, 2), ph: round(3.2 + noise(0.05), 2), sample_status: p === "Holding" ? "Pending lab" : p === "Discharging" ? "Released" : "Not sampled" },
        operator: name === "mixer1" ? "M. Walsh" : "S. Kelly",
      };
    }, undefined, 5);
  }

  private oven() {
    const base = "processing/oven1";
    const sps = [180, 210, 195];
    const zones = sps.map((sp) => new Lag(sp, 0.08));
    this.add(`${base}/state`, () => "Running", undefined, 10, true);
    sps.forEach((sp, i) => {
      const z = `zone${i + 1}`;
      this.add(`${base}/${z}/temperature`, (t) => {
        const over = this.fault(`${base}/${z}`) ? 28 : 0;
        return round(zones[i].step(sp + over + 1.5 * wave(t, 240, i)) + noise(0.4), 1);
      }, "°C", 1);
      this.add(`${base}/${z}/setpoint`, () => sp, "°C", 30, true);
    });
    this.add(`${base}/belt_speed`, (t) => round(1.8 + 0.05 * wave(t, 1800) + noise(0.01), 2), "m/min", 2);
    this.add(`${base}/gas_flow`, (t) => round(42 + 4 * wave(t, 300) + (this.fault(`${base}/zone2`) ? 9 : 0) + noise(0.5), 1), "m³/h", 2);
    this.add(`${base}/exhaust_temp`, (t) => round(140 + 5 * wave(t, 400) + noise(0.6), 1), "°C", 5);
  }

  private cip() {
    const base = "processing/cip";
    const active = () => [...this.lineStates.values()].includes("Changeover");
    this.add(`${base}/state`, () => (active() ? "Washing" : "Idle"), undefined, 5, true);
    this.add(`${base}/supply_temp`, () => round(active() ? 78 + noise(0.8) : 30 + noise(0.3), 1), "°C", 2);
    this.add(`${base}/conductivity`, () => round(active() ? 85 + noise(3) : 0.5 + noise(0.05), 2), "mS/cm", 2);
    this.add(`${base}/flow`, () => round(active() ? 12 + noise(0.4) : 0, 1), "m³/h", 2);
  }

  private utilities() {
    const base = "utilities";
    const pressure = new Lag(7.2, 0.1);
    const loadKw = () => [...this.lineStates.values()].filter((s) => s === "Running").length * 140 + 220;
    let kwh = 1_250_000;
    let water = 84_000;

    for (const c of ["compressor1", "compressor2"]) {
      const tripped = () => !!this.fault(`${base}/compressed_air/${c}`);
      this.add(`${base}/compressed_air/${c}/state`, () => (tripped() ? "Tripped" : "Running"), undefined, 5, true);
      this.add(`${base}/compressed_air/${c}/power`, (t) => round(tripped() ? 0 : 55 + 6 * wave(t, 200) + noise(1), 1), "kW", 2);
      this.add(`${base}/compressed_air/${c}/motor_temp`, (t) => round(tripped() ? 35 : 68 + 2 * wave(t, 500) + noise(0.4), 1), "°C", 5);
    }
    this.add(`${base}/compressed_air/header_pressure`, (t) => {
      const lost = this.fault(`${base}/compressed_air/compressor2`) ? 1.6 : 0;
      return round(pressure.step(7.2 - lost + 0.1 * wave(t, 90)) + noise(0.03), 2);
    }, "bar", 1);
    this.add(`${base}/compressed_air/dew_point`, () => round(3 + noise(0.2), 1), "°C", 10);

    this.add(`${base}/boiler/state`, () => "Running", undefined, 10, true);
    this.add(`${base}/boiler/steam_pressure`, (t) => round(10 + 0.3 * wave(t, 180) + noise(0.05), 2), "bar", 2);
    this.add(`${base}/boiler/water_level`, (t) => round(50 + 6 * wave(t, 240) + noise(0.5), 1), "%", 2);
    this.add(`${base}/boiler/flue_temp`, (t) => round(190 + 6 * wave(t, 600) + noise(0.8), 1), "°C", 5);
    // Nested JSON: boiler diagnostics. Health goes to Warning when the compressed-air trip starves the burner controls.
    this.add(`${base}/boiler/diagnostics`, (t) => {
      const warn = !!this.fault(`${base}/compressed_air/compressor2`);
      return {
        health: { status: warn ? "Warning" : "OK", score: round(warn ? 71 + noise(2) : 94 + noise(1), 1), message: warn ? "Low instrument air pressure at burner actuator" : "" },
        burner: { flame: "On", firing_rate_pct: round(62 + 8 * wave(t, 180) + noise(1), 1), fuel: { flow: { value: round(41 + 3 * wave(t, 180) + noise(0.4), 1), unit: "m³/h" }, type: "Natural gas" } },
        drum: { pressure: { value: round(10 + 0.3 * wave(t, 180) + noise(0.05), 2), unit: "bar" }, level: { value: round(50 + 6 * wave(t, 240) + noise(0.5), 1), unit: "%" } },
        maintenance: { last_service: "2026-08-14", next_service: "2026-11-14", run_hours: Math.round(4120 + t / 3600) },
      };
    }, undefined, 5);

    this.add(`${base}/power/main/active_power`, () => round(loadKw() + noise(8), 1), "kW", 2);
    this.add(`${base}/power/main/energy`, () => round((kwh += loadKw() / 1800), 1), "kWh", 10);
    this.add(`${base}/power/main/voltage_l1`, () => round(230 + noise(1.5), 1), "V", 5);
    this.add(`${base}/power/main/power_factor`, () => round(0.94 + noise(0.01), 3), undefined, 10);

    this.add(`${base}/chiller/supply_temp`, (t) => round(6 + 0.4 * wave(t, 900) + noise(0.1), 1), "°C", 5);
    this.add(`${base}/chiller/return_temp`, (t) => round(11 + 0.6 * wave(t, 900) + noise(0.15), 1), "°C", 5);
    this.add(`${base}/chiller/power`, (t) => round(85 + 10 * wave(t, 900) + noise(2), 1), "kW", 5);

    this.add(`${base}/water/flow`, (t) => round(18 + 4 * wave(t, 1200) + noise(0.5), 1), "m³/h", 2);
    this.add(`${base}/water/total`, () => round((water += 18 / 1800), 1), "m³", 10);
    this.add(`${base}/water/hardness`, () => round(120 + noise(2), 0), "ppm", 30);
  }
}
