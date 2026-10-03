"use client";

import { Icon } from "@/components/Icon";
import { TrackerMenu } from "@/components/tracker/TrackerMenu";
import { relativeTime, SORT_OPTIONS } from "@/lib/tracker/views";

import type { TrackerSortId } from "@/lib/tracker/views";

export type TrackerLayout = "board" | "list";

interface TrackerHeaderProps {
  builtAt: string | null;
  count: number | null;
  layout: TrackerLayout;
  now: number;
  onLayoutChange: (layout: TrackerLayout) => void;
  onRefresh: () => void;
  onSearchChange: (value: string) => void;
  onSortChange: (sort: TrackerSortId) => void;
  refreshing: boolean;
  search: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  sort: TrackerSortId;
  title: string;
}

/* Heavy view title + count, then search, List/Board, sort and Refresh. */
export function TrackerHeader({
  builtAt,
  count,
  layout,
  now,
  onLayoutChange,
  onRefresh,
  onSearchChange,
  onSortChange,
  refreshing,
  search,
  searchRef,
  sort,
  title,
}: TrackerHeaderProps): React.ReactElement {
  const sortLabel = SORT_OPTIONS.find((option) => option.id === sort)?.label ?? "Sort";

  return (
    <div className="trk-header">
      <h1 className="trk-title">
        {title}
        {count !== null ? <span className="trk-title-count">{count}</span> : null}
      </h1>

      <div className="trk-header-tools">
        <div className="trk-search">
          <span aria-hidden="true" className="trk-search-icon">
            <Icon name="search" size={14} />
          </span>
          <input
            aria-label="Search tickets by key, summary, account, assignee or CP key"
            className="trk-search-input"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                /* First Escape clears the search; the next one closes the panel. */
                event.stopPropagation();
                onSearchChange("");
              }
            }}
            placeholder="Search key, summary, account, CP…"
            ref={searchRef}
            type="search"
            value={search}
          />
          <kbd aria-hidden="true" className="trk-kbd">
            /
          </kbd>
        </div>

        <div aria-label="Layout" className="trk-segmented" role="group">
          <button aria-pressed={layout === "list"} onClick={() => onLayoutChange("list")} type="button">
            <Icon name="list" size={14} />
            List
          </button>
          <button aria-pressed={layout === "board"} onClick={() => onLayoutChange("board")} type="button">
            <Icon name="board" size={14} />
            Board
          </button>
        </div>

        <TrackerMenu
          align="end"
          buttonContent={
            <>
              <Icon name="sort" size={13} />
              {sortLabel}
            </>
          }
          buttonLabel={`Sort by ${sortLabel}`}
        >
          {(close) => (
            <div aria-label="Sort by" className="trk-menu-list" role="group">
              {SORT_OPTIONS.map((option) => (
                <button
                  aria-pressed={option.id === sort}
                  className="trk-menu-option"
                  key={option.id}
                  onClick={() => {
                    onSortChange(option.id);
                    close();
                  }}
                  type="button"
                >
                  <span className="trk-menu-check">{option.id === sort ? <Icon name="check" size={13} /> : null}</span>
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </TrackerMenu>

        <div className="trk-sync">
          <button className="trk-btn" disabled={refreshing} onClick={onRefresh} type="button">
            <span className={refreshing ? "trk-spin" : undefined}>
              <Icon name="refresh" size={13} />
            </span>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <span className="trk-sync-text" title={builtAt ? new Date(builtAt).toLocaleString() : undefined}>
            {builtAt ? `Synced ${relativeTime(builtAt, now)}` : "Not synced yet"}
          </span>
        </div>
      </div>
    </div>
  );
}
