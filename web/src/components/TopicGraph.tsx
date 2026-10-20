import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-2d";
import { isAlarm, type TopicRow } from "../api";
import { LEVELS, LEVEL_NAMES, STATUS } from "../colors";
import type { Live } from "../useLive";

interface GNode {
  id: string;
  name: string;
  depth: number;
  leaf: boolean;
  children: number;
}
interface GLink {
  source: string;
  target: string;
}

interface Props {
  live: Live;
  selected: string | null;
  onSelect: (topic: string) => void;
}

/** Force-directed view of the topic tree: one node per path segment, tags pulse as messages arrive. */
export function TopicGraph({ live, selected, onSelect }: Props) {
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
  const topicKey = [...live.topics.keys()].sort().join("\n");
  const data = useMemo(() => {
    const nodes = new Map<string, GNode>();
    const links: GLink[] = [];
    for (const topic of topicKey ? topicKey.split("\n") : []) {
      const parts = topic.split("/");
      parts.forEach((name, i) => {
        const id = parts.slice(0, i + 1).join("/");
        if (!nodes.has(id)) {
          nodes.set(id, { id, name, depth: i, leaf: false, children: 0 });
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
  }, [topicKey]);

  useEffect(() => {
    fg.current?.d3Force("charge")?.strength(-40);
    fg.current?.d3Force("link")?.distance((l: { target: GNode }) => (l.target.leaf ? 14 : 40 - l.target.depth * 4));
    const t = setTimeout(() => fg.current?.zoomToFit(600, 60), 1500);
    return () => clearTimeout(t);
  }, [data]);

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
        linkColor={() => "#2c2c2a"}
        linkWidth={1}
        nodeRelSize={4}
        onNodeHover={(n) => setHover(n?.leaf ? (n.id as string) : null)}
        onNodeClick={(n) => (n.leaf ? onSelect(n.id as string) : fg.current?.centerAt(n.x, n.y, 600))}
        nodeCanvasObject={(n, ctx, scale) => {
          const row = live.topics.get(n.id as string);
          const alarm = row ? isAlarm(row) : false;
          const r = n.leaf ? 2.2 + Math.min(3, (row?.rate ?? 0) / 25) : 7 - Math.min(n.depth, 4);
          const color = alarm ? STATUS.critical : LEVELS[Math.min(n.depth, LEVELS.length - 1)];
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
          if (n.id === selected || n.id === hover) {
            ctx.strokeStyle = "#f0efec";
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();
          }
          const showLabel = !n.leaf || scale > 2.2 || n.id === selected;
          if (showLabel) {
            const fontSize = Math.max(n.leaf ? 2.5 : 3.5, (n.leaf ? 10 : 12 - n.depth) / scale);
            ctx.font = `${n.leaf ? 400 : 600} ${fontSize}px Inter, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = n.leaf ? "#c3c2b7" : "#f0efec";
            ctx.fillText(n.name, n.x!, n.y! + r + 1.5);
          }
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, n.leaf ? 6 : 9, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
      <div className="graph-legend">
        {LEVEL_NAMES.map((name, i) => (
          <span key={name}>
            <i style={{ background: LEVELS[i] }} />
            {name}
          </span>
        ))}
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
