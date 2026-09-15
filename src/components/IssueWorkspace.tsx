"use client";

import { useDeferredValue, useMemo, useState } from "react";

import { BreakdownBars } from "@/components/BreakdownBars";
import { FilterDropdown } from "@/components/FilterDropdown";
import { Icon } from "@/components/Icon";
import { IssueDrawer } from "@/components/IssueDrawer";
import { IssueTable } from "@/components/IssueTable";
import { computeBreakdown, distinctValues } from "@/lib/issueRow";

import type { SortDirection, SortKey } from "@/components/IssueTable";
import type { IssueRow } from "@/lib/issueRow";

interface IssueWorkspaceProps {
  initialStatus?: string;
  rows: IssueRow[];
  showAssigneeTabs?: boolean;
}

interface FilterDimension {
  getValue: (row: IssueRow) => string | undefined;
  key: string;
  label: string;
}

const DIMENSIONS: FilterDimension[] = [
  { getValue: (row) => row.issue.project, key: "project", label: "Project" },
  { getValue: (row) => row.issue.status, key: "status", label: "Status" },
  { getValue: (row) => row.issue.priority, key: "priority", label: "Priority" },
  { getValue: (row) => row.issue.support_category, key: "category", label: "Category" },
  { getValue: (row) => row.issue.pod ?? row.issue.team, key: "pod", label: "POD" },
  { getValue: (row) => row.issue.assignee, key: "assignee", label: "Assignee" },
];
const DIMENSIONS_WITHOUT_ASSIGNEE = DIMENSIONS.filter(
  (dimension) => dimension.key !== "assignee",
);

const DESCENDING_DEFAULT: Partial<Record<SortKey, true>> = {
  age: true,
  created: true,
  risk: true,
  updated: true,
};

function compareRows(a: IssueRow, b: IssueRow, key: SortKey): number {
  switch (key) {
    case "key":
      return a.issue.key.localeCompare(b.issue.key);
    case "category":
      return (a.issue.support_category ?? "").localeCompare(b.issue.support_category ?? "");
    case "pod":
      return (a.issue.pod ?? a.issue.team ?? "").localeCompare(b.issue.pod ?? b.issue.team ?? "");
    case "priority":
      return a.issue.priority_sort - b.issue.priority_sort;
    case "status":
      return (a.issue.status ?? "").localeCompare(b.issue.status ?? "");
    case "risk":
      return (a.analysis?.risk_score ?? -1) - (b.analysis?.risk_score ?? -1);
    case "assignee":
      return (a.issue.assignee || "").localeCompare(b.issue.assignee || "");
    case "reporter":
      return (a.issue.reporter || "").localeCompare(b.issue.reporter || "");
    case "created":
      return new Date(a.issue.created ?? 0).getTime() - new Date(b.issue.created ?? 0).getTime();
    case "age":
      return (a.ageDays ?? -1) - (b.ageDays ?? -1);
    case "updated":
      return (
        new Date(a.issue.latest_comment_created || a.issue.updated || 0).getTime() -
        new Date(b.issue.latest_comment_created || b.issue.updated || 0).getTime()
      );
    default:
      return 0;
  }
}

export function IssueWorkspace({
  initialStatus,
  rows,
  showAssigneeTabs = false,
}: IssueWorkspaceProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, Set<string>>>(() => {
    const initialFilters: Record<string, Set<string>> = {};
    if (initialStatus) {
      initialFilters.status = new Set([initialStatus]);
    }
    return initialFilters;
  });
  const [activeAssignee, setActiveAssignee] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const assigneeTabs = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      if (row.issue.assignee) {
        counts.set(row.issue.assignee, (counts.get(row.issue.assignee) ?? 0) + 1);
      }
    });

    return Array.from(counts, ([name, count]) => ({ count, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [rows]);

  const rowsForAssignee = useMemo(
    () =>
      activeAssignee === "all"
        ? rows
        : rows.filter((row) => row.issue.assignee === activeAssignee),
    [activeAssignee, rows],
  );

  const dimensions = showAssigneeTabs ? DIMENSIONS_WITHOUT_ASSIGNEE : DIMENSIONS;

  const filterOptions = useMemo(
    () =>
      dimensions.map((dimension) => ({
        ...dimension,
        options: distinctValues(rowsForAssignee, dimension.getValue).map((value) => ({
          count: rowsForAssignee.filter((row) => dimension.getValue(row) === value).length,
          value,
        })),
      })),
    [dimensions, rowsForAssignee],
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return rowsForAssignee.filter((row) => {
      for (const dimension of dimensions) {
        const active = filters[dimension.key];
        if (active && active.size > 0) {
          const value = dimension.getValue(row);
          if (!value || !active.has(value)) {
            return false;
          }
        }
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        row.issue.key,
        row.issue.summary,
        row.issue.assignee,
        row.issue.reporter,
        row.issue.support_category,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [deferredQuery, dimensions, filters, rowsForAssignee]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const result = compareRows(a, b, sortKey);
      return sortDirection === "asc" ? result : -result;
    });
    return copy;
  }, [filteredRows, sortKey, sortDirection]);

  const handleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(DESCENDING_DEFAULT[key] ? "desc" : "asc");
  };

  const activeChips = dimensions.flatMap((dimension) =>
    Array.from(filters[dimension.key] ?? []).map((value) => ({ dimensionKey: dimension.key, value })),
  );

  const removeChip = (dimensionKey: string, value: string): void => {
    setFilters((prev) => {
      const next = new Set(prev[dimensionKey] ?? []);
      next.delete(value);
      return { ...prev, [dimensionKey]: next };
    });
  };

  const clearFilters = (): void => {
    setFilters({});
    setQuery("");
  };

  const selectedRow = selectedKey ? sortedRows.find((row) => row.issue.key === selectedKey) ?? null : null;

  return (
    <div>
      {showAssigneeTabs ? (
        <div aria-label="Filter tickets by assignee" className="person-tabs" role="tablist">
          <button
            aria-selected={activeAssignee === "all"}
            className={activeAssignee === "all" ? "person-tab active" : "person-tab"}
            onClick={() => {
              setActiveAssignee("all");
              setSelectedKey(null);
            }}
            role="tab"
            type="button"
          >
            <span>All</span>
            <span className="person-tab-count">{rows.length}</span>
          </button>
          {assigneeTabs.map((tab) => (
            <button
              aria-selected={activeAssignee === tab.name}
              className={activeAssignee === tab.name ? "person-tab active" : "person-tab"}
              key={tab.name}
              onClick={() => {
                setActiveAssignee(tab.name);
                setSelectedKey(null);
              }}
              role="tab"
              type="button"
            >
              <span>{tab.name}</span>
              <span className="person-tab-count">{tab.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="filter-bar">
        <input
          aria-label="Search issues"
          className="filter-search-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ticket ID, summary, assignee, reporter…"
          type="search"
          value={query}
        />
        {filterOptions.map((dimension) => (
          <FilterDropdown
            key={dimension.key}
            label={dimension.label}
            onChange={(next) => setFilters((prev) => ({ ...prev, [dimension.key]: next }))}
            options={dimension.options}
            selected={filters[dimension.key] ?? new Set()}
          />
        ))}
        {activeChips.length > 0 || query ? (
          <button className="filter-clear-btn" onClick={clearFilters} type="button">
            Clear filters
          </button>
        ) : null}
      </div>

      {activeChips.length > 0 ? (
        <div className="filter-chips">
          {activeChips.map((chip) => (
            <span className="filter-chip" key={`${chip.dimensionKey}-${chip.value}`}>
              {chip.value}
              <button
                aria-label={`Remove filter ${chip.value}`}
                className="filter-chip-remove"
                onClick={() => removeChip(chip.dimensionKey, chip.value)}
                type="button"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="analytics-row">
        <BreakdownBars entries={computeBreakdown(filteredRows, (row) => row.issue.status)} title="Status" />
        <BreakdownBars entries={computeBreakdown(filteredRows, (row) => row.issue.priority)} title="Priority" />
        <BreakdownBars
          entries={computeBreakdown(filteredRows, (row) => row.issue.support_category)}
          title="Issues by Category"
        />
      </div>

      <p className="result-count">
        Showing {sortedRows.length} of {rowsForAssignee.length} tickets
      </p>

      <IssueTable
        onRowClick={setSelectedKey}
        onSort={handleSort}
        rows={sortedRows}
        sortDirection={sortDirection}
        sortKey={sortKey}
      />

      <IssueDrawer onClose={() => setSelectedKey(null)} row={selectedRow} />
    </div>
  );
}
