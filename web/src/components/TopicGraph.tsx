import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-2d";
import { docOf, docTopics, graphTopics, isAlarm, type Focus, type TopicRow } from "../api";
import { JSON_COLOR, LEVELS, LEVEL_NAMES, STATUS } from "../colors";
import { topicMatcher } from "../filter";
import type { Live } from "../useLive";

interface GNode {
  id: string;
  name: string;
  depth: number;
  leaf: boolean;
  children: number;
  /** Inside a nested JSON document. */
  json: boolean;
}
interface GLink {
  source: string;
  target: string;
}

interface Props {
  live: Live;
  /** Topics with an open trend card. */
  selected: Set<string>;
  onSelect: (topic: string) => void;
  /** Highlight request from elsewhere, e.g. a topic clicked in a chat answer. */
  focus?: Focus;
}

/** Force-directed view of the topic tree: one node per path segment, tags pulse as messages arrive. */
export function TopicGraph({ live, selected, onSelect, focus }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphMethods<NodeObject<GNode>> | undefined>(undefined);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Only rebuild the graph when the set of topics changes, so the layout stays put.
  const topicKey = graphTopics(live.topics).sort().join("\n");
  const docKey = docTopics(live.topics).sort().join("\n");
  const data = useMemo(() => {
    const docs = docKey ? docKey.split("\n") : [];
    const nodes = new Map<string, GNode>();
    const links: GLink[] = [];
    for (const topic of topicKey ? topicKey.split("\n") : []) {
      const parts = topic.split("/");
      parts.forEach((name, i) => {
        const id = parts.slice(0, i + 1).join("/");
        if (!nodes.has(id)) {
          nodes.set(id, { id, name, depth: i, leaf: false, children: 0, json: !!docOf(docs, id) });
          if (i > 0) {
            const parent = parts.slice(0, i).join("/");
            links.push({ source: parent, target: id });
            nodes.get(parent)!.children++;
          }
        }
      });
      nodes.get(topic)!.leaf = true;
    }
    return { nodes: [...nodes.values()], links };
  }, [topicKey, docKey]);

  // Whether the layout has settled since the graph last changed, so zooming to a node lands where it stays.
  const settled = useRef(false);
  useEffect(() => {
    settled.current = false;
    fg.current?.d3Force("charge")?.strength(-40);
    fg.current?.d3Force("link")?.distance((l: { target: GNode }) => (l.target.leaf ? 14 : 40 - l.target.depth * 4));
    // Fit everything once laid out, unless a search or highlight has already zoomed in.
    const t = setTimeout(() => !queryRef.current && fg.current?.zoomToFit(600, 60), 1500);
    return () => clearTimeout(t);
  }, [data]);

  // Search: matching tags and their parent branches stay bright, everything else dims.
  const [query, setQuery] = useState(focus?.query ?? "");
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (focus) setQuery(focus.query);
  }, [focus?.nonce]);
  const hits = useMemo(() => {
    const match = topicMatcher(query);
    if (!match) return null;
    const tags = new Set<string>();
    const lit = new Set<string>();
    for (const n of data.nodes) {
      if (!n.leaf || !match(n.id, live.topics.get(n.id))) continue;
      tags.add(n.id);
      const parts = n.id.split("/");
      parts.forEach((_, i) => lit.add(parts.slice(0, i + 1).join("/")));
    }
    return { tags, lit };
  }, [query, data, live.version]);

  const hitKey = hits ? [...hits.tags].sort().join("\n") : "";
  useEffect(() => {
    if (!hits?.tags.size) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    const go = () => {
      // One hit: zoom right in on it (once the layout has placed it). Several: fit them all.
      const only = hits.tags.size === 1 ? (data.nodes.find((n) => hits.tags.has(n.id)) as NodeObject<GNode> | undefined) : undefined;
      if (!settled.current && tries++ < 12) t = setTimeout(go, 300);
      else if (only) {
        fg.current?.centerAt(only.x, only.y, 600);
        fg.current?.zoom(3, 600);
      } else fg.current?.zoomToFit(600, 80, (n) => hits.tags.has(n.id as string));
    };
    t = setTimeout(go, 250);
    return () => clearTimeout(t);
  }, [hitKey, focus?.nonce]);

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setQuery("");
    if (e.key === "Enter" && hits?.tags.size) onSelect([...hits.tags].sort()[0]);
  };

  const hovered = hover ? live.topics.get(hover) : undefined;

  return (
    <div className="graph-wrap" ref={wrap}>
      <ForceGraph2D<GNode, GLink>
        ref={fg}
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="#0d0d0d"
        autoPauseRedraw={false}
        cooldownTicks={200}
        onEngineStop={() => (settled.current = true)}
        linkColor={(l) => (hits && !hits.lit.has((l.target as unknown as GNode).id) ? "#1a1a19" : "#2c2c2a")}
        linkWidth={1}
        nodeRelSize={4}
        onNodeHover={(n) => setHover(n?.leaf ? (n.id as string) : null)}
        onNodeClick={(n) => {
          if (n.leaf || live.topics.get(n.id as string)?.doc) onSelect(n.id as string); // a JSON document opens its raw JSON card
          if (!n.leaf) fg.current?.centerAt(n.x, n.y, 600);
        }}
        nodeCanvasObject={(n, ctx, scale) => {
          const row = live.topics.get(n.id as string);
          const dim = hits ? !hits.lit.has(n.id as string) : false;
          const hit = hits?.tags.has(n.id as string) ?? false;
          ctx.globalAlpha = dim ? 0.12 : 1;
          const alarm = row ? isAlarm(row) : false;
          const r = n.leaf ? 2.2 + Math.min(3, (row?.rate ?? 0) / 25) : 7 - Math.min(n.depth, 4);
          const color = alarm ? STATUS.critical : n.leaf ? LEVELS[5] : n.json ? JSON_COLOR : LEVELS[Math.min(n.depth, 4)];
          const pulse = live.pulses.get(n.id as string);
          const age = pulse ? Date.now() - pulse : Infinity;
          if (n.leaf && age < 1200) {
            ctx.beginPath();
            ctx.arc(n.x!, n.y!, r + (age / 1200) * 6, 0, 2 * Math.PI);
            ctx.strokeStyle = `rgba(57,135,229,${1 - age / 1200})`;
            ctx.lineWidth = 1 / scale + 0.5;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          if (hit || selected.has(n.id) || n.id === hover) {
            ctx.strokeStyle = hit && !selected.has(n.id) && n.id !== hover ? "#3987e5" : "#f0efec";
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();
          }
          const showLabel = (!n.leaf && !dim) || (hit && (hits!.tags.size <= 20 || scale > 2.2)) || (!hits && scale > 2.2) || selected.has(n.id);
          if (showLabel) {
            const fontSize = Math.max(n.leaf ? 2.5 : 3.5, (n.leaf ? 10 : 12 - n.depth) / scale);
            ctx.font = `${n.leaf ? 400 : 600} ${fontSize}px Inter, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = n.leaf ? "#c3c2b7" : "#f0efec";
            ctx.fillText(n.name, n.x!, n.y! + r + 1.5);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, n.leaf ? 6 : 9, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
      <div className="graph-search">
        <label className="search">
          <Search size={14} />
          <input
            placeholder="Search topics or values: temp, line2, Down, +/+/+/+/+/motor_temp"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query && (
            <button className="icon" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
        {hits && <span className="small muted">{hits.tags.size ? `${hits.tags.size} of ${live.topics.size} topics · Enter opens the first` : "No topics match"}</span>}
      </div>
      <div className="graph-legend">
        {LEVEL_NAMES.map((name, i) => (
          <span key={name}>
            <i style={{ background: LEVELS[i] }} />
            {name}
          </span>
        ))}
        <span>
          <i style={{ background: JSON_COLOR }} />
          JSON document
        </span>
        <span>
          <i style={{ background: STATUS.critical }} />
          Alarm / down
        </span>
      </div>
      {hovered && <HoverCard row={hovered} />}
    </div>
  );
}

function HoverCard({ row }: { row: TopicRow }) {
  let value = row.value != null ? `${row.value}${row.unit ? ` ${row.unit}` : ""}` : row.payload;
  try {
    if (row.value == null) value = String(JSON.parse(row.payload).value ?? row.payload);
  } catch {}
  return (
    <div className="hover-card">
      <div className="mono small muted">{row.topic}</div>
      <div className="hover-value">{value}</div>
      <div className="small muted">
        {row.rate.toFixed(0)} msg/min · {Math.round((Date.now() - row.lastTs) / 1000)} s ago
      </div>
    </div>
  );
}
