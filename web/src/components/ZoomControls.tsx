import { ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import type { TimeWindow } from "../useTimeWindow";

const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Zoom in/out, pan and reset buttons for a TimeWindow. */
export function ZoomControls({ win, compact = false }: { win: TimeWindow; compact?: boolean }) {
  const s = compact ? 12 : 14;
  return (
    <div className={`zoom-controls ${compact ? "compact" : ""}`}>
      {!compact && win.zoomed && <span className="small muted zoom-range">{`${fmt(win.from)}–${fmt(win.to)}`}</span>}
      <button onClick={win.panLeft} title="Pan back in time" aria-label="Pan back in time">
        <ChevronLeft size={s} />
      </button>
      <button onClick={win.zoomIn} title="Zoom in" aria-label="Zoom in">
        <ZoomIn size={s} />
      </button>
      <button onClick={win.zoomOut} title="Zoom out" aria-label="Zoom out">
        <ZoomOut size={s} />
      </button>
      <button onClick={win.panRight} disabled={win.live} title="Pan forward in time" aria-label="Pan forward in time">
        <ChevronRight size={s} />
      </button>
      <button onClick={win.reset} disabled={win.live} title="Reset to live" aria-label="Reset to live" className={win.zoomed ? "reset on" : "reset"}>
        <RotateCcw size={s} />
        {!compact && " Live"}
      </button>
    </div>
  );
}
