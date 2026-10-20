import { cluster, hierarchy } from "d3-hierarchy";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { display, docOf, docTopics, graphTopics, isAlarm } from "../api";
import { JSON_COLOR, LEVELS, STATUS } from "../colors";
import { topicMatcher } from "../filter";
import type { Live } from "../useLive";

interface TNode {
  id: string;
  name: string;
  depth: number;
  leaf: boolean;
  /** Inside a nested JSON document. */
  json: boolean;
  children: TNode[];
}

const ROW = 24;
const COL = 170;
const LEVEL_BADGE = ["Enterprise", "Site", "Area", "Line", "Cell"];

interface Props {
  live: Live;
  /** Topics with an open trend card. */
  selected: Set<string>;
  onSelect: (topic: string) => void;
}

/** Left-to-right view of the topic tree: one column per ISA-95 level, branches fold, tags show live values. */
export function TopicTree({ live, selected, onSelect }: Props) {
  const topicKey = graphTopics(live.topics).sort().join("\n");
  const docKey = docTopics(live.topics).sort().join("\n");
  const root = useMemo(() => {
    const docs = docKey ? docKey.split("\n") : [];
    const byId = new Map<string, TNode>();
    const top: TNode = { id: "", name: "", depth: -1, leaf: false, json: false, children: [] };
    for (const topic of topicKey ? topicKey.split("\n") : []) {
      const parts = topic.split("/");
      let parent = top;
      parts.forEach((name, i) => {
        const id = parts.slice(0, i + 1).join("/");
        let n = byId.get(id);
        if (!n) {
          n = { id, name, depth: i, leaf: false, json: !!docOf(docs, id), children: [] };
          byId.set(id, n);
          parent.children.push(n);
        }
        parent = n;
      });
      parent.leaf = true;
    }
    return top.children.length === 1 ? top.children[0] : top;
  }, [topicKey, docKey]);

  const branchesFrom = (minDepth: number) => {
    const s = new Set<string>();
    // Inside a JSON document only the document itself folds, so opening it shows the whole structure.
    const walk = (n: TNode, inJson: boolean) => {
      if (!n.leaf && !inJson && (n.depth >= minDepth || n.json)) s.add(n.id);
      n.children.forEach((c) => walk(c, n.json));
    };
    walk(root, false);
    return s;
  };
  // null = the default view, with cells folded so the first view fits on screen.
  const [userCollapsed, setCollapsed] = useState<Set<string> | null>(null);
  const collapsed = useMemo(() => userCollapsed ?? branchesFrom(4), [userCollapsed, root]);

  // Filter by topic path or current value text, or by an MQTT filter with + / #.
  // While it's set, matching branches open and everything else is hidden.
  const [filter, setFilter] = useState("");
  const keep = useMemo(() => {
    const match = topicMatcher(filter);
    if (!match) return null;
    const ids = new Set<string>();
    const walk = (n: TNode): boolean => {
      let hit = n.leaf && match(n.id, live.topics.get(n.id));
      for (const c of n.children) if (walk(c)) hit = true;
      if (hit) ids.add(n.id);
      return hit;
    };
    walk(root);
    return ids;
  }, [filter, root, live.version]);
  const matches = keep ? [...keep].filter((id) => live.topics.has(id)).length : 0;

  const layout = useMemo(() => {
    const h = hierarchy(root, (n) => (keep ? n.children.filter((c) => keep.has(c.id)) : collapsed.has(n.id) ? null : n.children));
    cluster<TNode>().nodeSize([ROW, COL]).separation((a, b) => (a.parent === b.parent ? 1 : 1.4))(h);
    const nodes = h.descendants();
    const minY = Math.min(...nodes.map((n) => n.x ?? 0));
    const maxY = Math.max(...nodes.map((n) => n.x ?? 0));
    const maxX = Math.max(...nodes.map((n) => n.y ?? 0));
    return { nodes, links: h.links(), offsetY: -minY + ROW, height: maxY - minY + ROW * 2, width: maxX + 380 };
  }, [root, collapsed, keep]);

  const toggle = (id: string) =>
    setCollapsed(() => {
      const n = new Set(collapsed);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const collapseAll = () => {
    setFilter("");
    setCollapsed(branchesFrom(2));
  };
  const tagCount = (n: TNode): number => (n.leaf ? 1 : n.children.reduce((a, c) => a + tagCount(c), 0));
  const now = Date.now();

  return (
    <div className="tree-view">
      <div className="tree-actions">
        <label className="search tree-filter">
          <Search size={14} />
          <input
            placeholder="Filter: temp, line2, Down, +/+/+/+/+/motor_temp"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
        </label>
        {keep && <span className="small muted">{matches ? `${matches} of ${live.topics.size} topics` : "No topics match"}</span>}
        <button
          onClick={() => {
            setFilter("");
            setCollapsed(new Set());
          }}
        >
          Expand all
        </button>
        <button onClick={collapseAll}>Collapse all</button>
      </div>
      <svg width={layout.width} height={layout.height} className="tree-svg">
        <g transform={`translate(24, ${layout.offsetY})`}>
          {layout.links.map((l) => {
            const sx = l.source.y!, sy = l.source.x!, tx = l.target.y!, ty = l.target.x!;
            const mx = (sx + tx) / 2;
            return <path key={l.target.data.id} d={`M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`} className="tree-link" />;
          })}
          {layout.nodes.map((h) => {
            const n = h.data;
            const x = h.y!, y = h.x!;
            const row = n.leaf ? live.topics.get(n.id) : undefined;
            const alarm = row ? isAlarm(row) : false;
            const fresh = row && now - row.lastTs < 1200;
            const color = alarm ? STATUS.critical : n.leaf ? LEVELS[5] : n.json ? JSON_COLOR : LEVELS[Math.min(n.depth, 4)];
            const folded = collapsed.has(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${x},${y})`}
                className={`tree-node ${n.leaf ? "leaf" : "branch"} ${selected.has(n.id) ? "selected" : ""}`}
                onClick={() => (n.leaf ? onSelect(n.id) : toggle(n.id))}
              >
                <rect x={-8} y={-ROW / 2} width={n.leaf ? 360 : COL - 24} height={ROW} className="hit" />
                {fresh && <circle r={4} className="pulse" key={row!.lastTs} style={{ stroke: alarm ? STATUS.critical : undefined }} />}
                <circle r={n.leaf ? 3.5 : 5.5} fill={color} />
                {n.leaf ? (
                  <text x={10} dy="0.35em" className="tree-text">
                    <tspan className="tag-name">{n.name}</tspan>
                    <tspan dx={10} className={`tag-value ${alarm ? "bad" : ""}`}>
                      {row ? display(row) : ""}
                    </tspan>
                  </text>
                ) : (
                  <text x={10} dy="0.35em" className="tree-text">
                    <tspan className="branch-name">{n.name}</tspan>
                    <tspan dx={8} className="badge" style={color === LEVELS[0] ? undefined : { fill: color }}>
                      {n.json ? "JSON" : LEVEL_BADGE[Math.min(n.depth, 4)]}
                    </tspan>
                    {live.topics.get(n.id)?.doc && (
                      <tspan
                        dx={8}
                        className="raw-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(n.id);
                        }}
                      >
                        <title>Show the raw JSON</title>
                        {"{ }"}
                      </tspan>
                    )}
                    {folded && !keep && <tspan dx={8} className="count">▸ {tagCount(n)} tags</tspan>}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
