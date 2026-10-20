import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { runTool, tools, type ChartRequest, type ToolContext } from "./tools.js";

const client = new Anthropic();

const SYSTEM = `You are an assistant for an industrial MQTT broker. You answer questions about what is happening on the broker right now and over the recorded history (up to ${config.retentionMinutes} minutes), using the tools to read real data. Never invent values: if the data doesn't show something, say so.

The broker usually follows a Unified Namespace laid out to ISA-95: enterprise/site/area/line/cell/tag. Payloads are often JSON with value, unit, quality and timestamp fields. Some topics carry nested JSON documents instead (work orders, batch records, robot and boiler diagnostics). The recorder splits each one into field topics at <document topic>/<json path>, for example acme/dublin/utilities/boiler/diagnostics/drum/pressure, each with its own history. Numeric fields work with get_history and get_stats, text fields with get_state_changes, and get_latest on the document topic returns the whole document. The filler counter documents carry a seq number per message; use check_sequence_gaps for questions about missed or dropped data. Each area has network tags at <area>/network/ (latency_ms, jitter_ms, packet_loss_pct, throughput_mbps, retransmits_per_min, link_state); latency drifts above 5000 ms roughly every 10 minutes, and a predictor publishes <area>/network/prediction. Use predict_network_drift for questions about that. Filler fill_weight (spec 495-505 g, target 500 g) has occasional special causes (mean shifts, drifts, extra variation); use spc_analysis for SPC, control limits, rule violations and Cp/Cpk.

How to work:
- If you don't yet know the topic tree, call broker_overview or list_topics before guessing topic names.
- Prefer get_stats and find_anomalies for broad questions, get_history for one signal's trend, get_state_changes for states, alarms and batch phases.
- When a trend or comparison would help, call show_chart so the user sees it in the chat.
- Answer concisely in Markdown: lead with the answer, include the key numbers with units and times, then brief supporting detail. Times are UTC unless the user says otherwise.`;

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; preview: string }
  | { type: "chart"; chart: ChartRequest }
  | { type: "done" }
  | { type: "error"; message: string };

/** Conversations are kept server-side and only ever appended to, so thinking blocks stay valid. */
const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

export function resetSession(id: string) {
  sessions.delete(id);
}

export async function chat(sessionId: string, userText: string, ctx: Omit<ToolContext, "onChart">, emit: (e: ChatEvent) => void, signal?: AbortSignal) {
  const messages = sessions.get(sessionId) ?? [];
  sessions.set(sessionId, messages);
  messages.push({ role: "user", content: `[now: ${new Date().toISOString()}]\n${userText}` });

  const toolCtx: ToolContext = { ...ctx, onChart: (chart) => emit({ type: "chart", chart }) };

  for (let turn = 0; turn < 20; turn++) {
    const stream = client.beta.messages.stream(
      {
        model: config.model,
        max_tokens: 64000,
        system: SYSTEM,
        tools,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
      },
      { signal },
    );
    stream.on("text", (text) => emit({ type: "text", text }));
    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (message.stop_reason === "refusal") {
      emit({ type: "text", text: "\n\n_The model declined to answer this request._" });
      break;
    }
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!toolUses.length || message.stop_reason !== "tool_use") break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
      emit({ type: "tool", id: tu.id, name: tu.name, input: tu.input });
      const res = runTool(tu.name, tu.input, toolCtx);
      emit({ type: "tool_result", id: tu.id, ok: !res.isError, preview: res.content.slice(0, 300) });
      return { type: "tool_result", tool_use_id: tu.id, content: res.content, is_error: res.isError };
    });
    messages.push({ role: "user", content: results });
  }
  emit({ type: "done" });
}
