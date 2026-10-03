"use client";

import { Icon } from "@/components/Icon";
import { TrackerMenu } from "@/components/tracker/TrackerMenu";
import { EMPTY_FILTERS, facetOptions, FILTER_FACETS, hasActiveFilters, toggleFilterValue } from "@/lib/tracker/views";

import type { TrackerTicket } from "@/lib/tracker/types";
import type { FilterFacet, TrackerFilters } from "@/lib/tracker/views";

interface TrackerFilterBarProps {
  filters: TrackerFilters;
  /* Attention reasons depend on the time, so the menus count them as of the page's clock. */
  now: number;
  onChange: (filters: TrackerFilters) => void;
  /* The tickets in the current view, before filters - what the menus offer and count. */
  tickets: TrackerTicket[];
}

/* Facet menus on the left; applied filters as lavender "Priority is Critical ×" chips, then Reset. */
export function TrackerFilterBar({ filters, now, onChange, tickets }: TrackerFilterBarProps): React.ReactElement {
  const labelFor = (facet: FilterFacet, value: string): string =>
    facetOptions(tickets, facet, now).find((option) => option.value === value)?.label ?? value;

  return (
    <div className="trk-filterbar">
      <div className="trk-filter-menus">
        <span aria-hidden="true" className="trk-filter-icon">
          <Icon name="layers" size={13} />
        </span>
        {FILTER_FACETS.map(({ facet, label }) => {
          const options = facetOptions(tickets, facet, now);
          const selected = filters[facet];
          return (
            <TrackerMenu
              active={selected.length > 0}
              buttonContent={
                <>
                  {label}
                  {selected.length > 0 ? <span className="trk-filter-count">{selected.length}</span> : null}
                </>
              }
              buttonLabel={`Filter by ${label}`}
              key={facet}
            >
              {() =>
                options.length === 0 ? (
                  <div className="trk-menu-empty">Nothing to filter in this view.</div>
                ) : (
                  <div aria-label={`Filter by ${label}`} className="trk-menu-list" role="group">
                    {options.map((option) => (
                      <label className="trk-menu-option" key={option.value}>
                        <input
                          checked={selected.includes(option.value)}
                          onChange={() => onChange(toggleFilterValue(filters, facet, option.value))}
                          type="checkbox"
                        />
                        <span className="trk-menu-option-label">{option.label}</span>
                        <span className="trk-menu-option-count">{option.count}</span>
                      </label>
                    ))}
                  </div>
                )
              }
            </TrackerMenu>
          );
        })}
      </div>

      {hasActiveFilters(filters) ? (
        <div className="trk-chips">
          {FILTER_FACETS.flatMap(({ facet, label }) =>
            filters[facet].map((value) => (
              <span className="trk-chip" key={`${facet}:${value}`}>
                <span>
                  {label} is <strong>{labelFor(facet, value)}</strong>
                </span>
                <button
                  aria-label={`Remove filter ${label} is ${labelFor(facet, value)}`}
                  className="trk-chip-remove"
                  onClick={() => onChange(toggleFilterValue(filters, facet, value))}
                  type="button"
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            )),
          )}
          <button className="trk-link-btn" onClick={() => onChange(EMPTY_FILTERS)} type="button">
            Reset
          </button>
        </div>
      ) : null}
    </div>
  );
}
