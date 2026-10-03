"use client";

import { Icon } from "@/components/Icon";
import { TRACKER_VIEWS } from "@/lib/tracker/views";

import type { IconName } from "@/components/Icon";
import type { TrackerViewId } from "@/lib/tracker/views";

const VIEW_ICON: Record<TrackerViewId, IconName> = {
  all_open: "layers",
  breaching: "clock",
  closed_recent: "check-circle",
  critical: "alert",
  engineering: "wrench",
  following: "star",
  high: "zap",
  manual: "user",
  medium_wfp: "history",
  mine: "inbox",
  slack_active: "message",
  unassigned: "user",
};

interface TrackerViewsNavProps {
  counts: Record<TrackerViewId, number> | null;
  onSelect: (view: TrackerViewId) => void;
  selected: TrackerViewId;
}

function sections(): Array<{ label: string; views: typeof TRACKER_VIEWS }> {
  const result: Array<{ label: string; views: typeof TRACKER_VIEWS }> = [];
  for (const view of TRACKER_VIEWS) {
    const last = result.at(-1);
    if (last && last.label === view.section) {
      last.views.push(view);
    } else {
      result.push({ label: view.section, views: [view] });
    }
  }
  return result;
}

/* The saved views on the left (a plain select on phones), each with its live count. */
export function TrackerViewsNav({ counts, onSelect, selected }: TrackerViewsNavProps): React.ReactElement {
  return (
    <>
      <nav aria-label="Tracker views" className="trk-views">
        {sections().map((section) => (
          <div className="trk-views-section" key={section.label}>
            <div className="trk-section-label">{section.label}</div>
            {section.views.map((view) => (
              <button
                aria-current={view.id === selected ? "true" : undefined}
                /* The label is hidden visually when the column shrinks to an icon rail, so name the button outright. */
                aria-label={counts ? `${view.label}, ${counts[view.id]}` : view.label}
                className="trk-view-item"
                key={view.id}
                onClick={() => onSelect(view.id)}
                title={view.label}
                type="button"
              >
                <span className="trk-view-icon">
                  <Icon name={VIEW_ICON[view.id]} size={15} />
                </span>
                <span className="trk-view-label">{view.label}</span>
                <span className="trk-view-count">{counts ? counts[view.id] : ""}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <label className="trk-views-select">
        <span className="visually-hidden">View</span>
        <select onChange={(event) => onSelect(event.target.value as TrackerViewId)} value={selected}>
          {TRACKER_VIEWS.map((view) => (
            <option key={view.id} value={view.id}>
              {view.label}
              {counts ? ` (${counts[view.id]})` : ""}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
