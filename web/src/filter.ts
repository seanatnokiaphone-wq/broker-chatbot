import { textValue, type TopicRow } from "./api";

function mqttMatch(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/**
 * Returns a matcher for a topic search box: plain text matches the topic path or the current value,
 * text with + or # is treated as an MQTT filter. Returns null for an empty query.
 */
export function topicMatcher(query: string): ((topic: string, row?: TopicRow) => boolean) | null {
  const f = query.trim().toLowerCase();
  if (!f) return null;
  if (/[+#]/.test(f)) return (topic) => mqttMatch(f, topic.toLowerCase());
  return (topic, row) => {
    if (topic.toLowerCase().includes(f)) return true;
    const value = row ? String(row.value ?? textValue(row) ?? "").toLowerCase() : "";
    return value.includes(f);
  };
}
