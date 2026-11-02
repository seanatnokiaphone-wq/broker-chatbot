import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { display, isAlarm, type TopicRow } from "../api";
import { SERIES } from "../colors";
import type { Live } from "../useLive";
import { useTimeWindow } from "../useTimeWindow";
import { HistoryChart } from "./HistoryChart";
import { ZoomControls } from "./ZoomControls";
import { StateTimeline } from "./StateTimeline";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  row?: TopicRow;
}

const RANGES = [
  { label: "15 min", minutes: 15 },
  { label: "1 h", minutes: 60 },
  { label: "3 h", minutes: 180 },
];

interface Props {
  live: Live;
  chartTopics: string[];
  onToggle: (topic: string) => void;
}

/** Topic tree with live values; picked topics are charted over the chosen window. */
export function Explorer({ live, chartTopics, onToggle }: Props) {
  const [filter, setFilter] = useState("");
  const win = useTimeWindow(60);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    const root: TreeNode = { name: "", path: "", children: new Map() };
    const f = filter.toLowerCase();
    for (const row of live.topics.values()) {
      if (row.doc) continue; // its fields are listed underneath it instead
      if (f && !row.topic.toLowerCase().includes(f)) continue;
      let node = root;
      row.topic.split("/").forEach((name, i, parts) => {
        const path = parts.slice(0, i + 1).join("/");
        if (!node.children.has(name)) node.children.set(name, { name, path, children: new Map() });
        node = node.children.get(name)!;
      });
      node.row = row;
    }
    return root;
  }, [live.version, filter]);

  const numeric = chartTopics.filter((t) => live.topics.get(t)?.value != null);
  const text = chartTopics.filter((t) => !numeric.includes(t));
  const units = Object.fromEntries(numeric.map((t) => [t, live.topics.get(t)?.unit]));

  const toggleCollapse = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });

  const render = (node: TreeNode, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => {
        const open = !collapsed.has(child.path);
        const leaf = child.children.size === 0;
        const idx = chartTopics.indexOf(child.path);
        return (
          <div key={child.path}>
            <div
              className={`tree-row ${idx >= 0 ? "picked" : ""} ${child.row && isAlarm(child.row) ? "alarm" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (leaf ? onToggle(child.path) : toggleCollapse(child.path))}
              title={leaf && child.row?.value == null ? "Text topic: charted as a state timeline" : undefined}
            >
              {leaf ? <span className="dot" style={{ background: idx >= 0 ? SERIES[idx % SERIES.length] : "transparent" }} /> : open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className={leaf ? "" : "branch"}>{child.name}</span>
              {child.row && <span className="tree-value mono">{display(child.row)}</span>}
            </div>
            {!leaf && open && render(child, depth + 1)}
          </div>
        );
      });

  return (
    <div className="explorer">
      <div className="explorer-tree">
        <label className="search">
          <Search size={14} />
          <input placeholder="Filter topics" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="tree-scroll">{render(tree, 0)}</div>
      </div>
      <div className="explorer-chart">
        <div className="toolbar">
          <span className="muted small">{chartTopics.length ? `${chartTopics.length} of 6 topics` : "Click topics to chart them (text topics show as state timelines)"}</span>
          <div className="toolbar-right">
            <ZoomControls win={win} />
            <div className="segmented">
              {RANGES.map((r) => (
                <button key={r.minutes} className={!win.zoomed && win.minutes === r.minutes ? "on" : ""} onClick={() => win.setMinutes(r.minutes)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {chartTopics.length ? (
          <>
            {numeric.length > 0 && <HistoryChart topics={numeric} from={win.from} to={win.to} units={units} live={win.live} height={text.length ? 300 : 420} onZoom={win.zoomTo} />}
            {text.length > 0 && <StateTimeline topics={text} from={win.from} to={win.to} live={win.live} />}
            <div className="small muted zoom-hint">Drag across a chart to zoom into that range.</div>
          </>
        ) : (
          <div className="empty">Pick topics from the tree to compare their history.</div>
        )}
      </div>
    </div>
  );
}
