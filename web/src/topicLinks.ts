/**
 * Finds topic names in a chat answer and turns them into links the UI can act on: full paths, the short
 * paths people write (line2/filler/motor_temp), branches (packaging/line1) and MQTT filters (+/+/motor_temp).
 */

export const TOPIC_HREF = "#topic:";
const CANDIDATE = /`?([A-Za-z0-9_.\-+#]+(?:\/[A-Za-z0-9_.\-+#]+)+)`?/g;

export interface TopicIndex {
  /** Every topic and every branch (path prefix). */
  paths: Set<string>;
  /** Last-n-segments suffix to the paths that end with it. */
  suffixes: Map<string, string[]>;
}

export function buildTopicIndex(topics: Iterable<string>): TopicIndex {
  const paths = new Set<string>();
  for (const t of topics) {
    const parts = t.split("/");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  const suffixes = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length - 2; i++) {
      const suffix = parts.slice(i).join("/");
      suffixes.set(suffix, [...(suffixes.get(suffix) ?? []), p]);
    }
  }
  return { paths, suffixes };
}

/**
 * The topic, branch or filter a piece of text refers to, or null. A short path that fits several topics
 * (filler/motor_temp) resolves to all of them, comma-separated.
 */
export function resolveTopic(text: string, index: TopicIndex): string | null {
  const t = text.replace(/[.,;:)]+$/, "");
  if (index.paths.has(t)) return t;
  if (/[+#]/.test(t)) return t; // an MQTT filter: highlight everything it matches
  const hits = index.suffixes.get(t);
  return hits && hits.length <= 12 ? hits.join(", ") : null;
}

/** Rewrites topic mentions in Markdown as links to TOPIC_HREF + topic, leaving fenced code blocks alone. */
export function linkTopics(md: string, index: TopicIndex): { md: string; topics: string[] } {
  const found = new Set<string>();
  const out = md
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) =>
      i % 2
        ? chunk
        : chunk.replace(CANDIDATE, (whole, cand: string, offset: number, all: string) => {
            // Skip text already inside a Markdown link.
            if (all[offset - 1] === "[" || all.slice(offset - 2, offset) === "](") return whole;
            const topic = resolveTopic(cand, index);
            if (!topic) return whole;
            found.add(topic);
            const trail = cand.match(/[.,;:)]+$/)?.[0] ?? "";
            const label = whole.startsWith("`") ? `\`${cand.slice(0, cand.length - trail.length)}\`` : cand.slice(0, cand.length - trail.length);
            return `[${label}](${TOPIC_HREF}${encodeURIComponent(topic)})${whole.startsWith("`") ? "" : trail}`;
          }),
    )
    .join("");
  return { md: out, topics: [...found] };
}
