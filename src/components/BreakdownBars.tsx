import type { BreakdownEntry } from "@/lib/issueRow";

interface BreakdownBarsProps {
  entries: BreakdownEntry[];
  limit?: number;
  title: string;
}

export function BreakdownBars({ entries, limit = 8, title }: BreakdownBarsProps): React.ReactElement {
  const visible = entries.slice(0, limit);
  const max = Math.max(1, ...visible.map((entry) => entry.count));

  return (
    <div className="analytics-panel">
      <div className="analytics-panel-title">{title}</div>
      {visible.length === 0 ? (
        <p className="breakdown-empty">No data yet.</p>
      ) : (
        <div className="breakdown-list">
          {visible.map((entry) => (
            <div className="breakdown-row" key={entry.label}>
              <span className="breakdown-label" title={entry.label}>{entry.label}</span>
              <span className="breakdown-bar-track">
                <span
                  className="breakdown-bar-fill"
                  style={{ inlineSize: `${(entry.count / max) * 100}%` }}
                />
              </span>
              <span className="breakdown-count">{entry.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
