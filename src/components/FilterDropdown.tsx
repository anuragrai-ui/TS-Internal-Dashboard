"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";

interface FilterOption {
  count: number;
  value: string;
}

interface FilterDropdownProps {
  label: string;
  onChange: (next: Set<string>) => void;
  options: FilterOption[];
  selected: Set<string>;
}

export function FilterDropdown({ label, onChange, options, selected }: FilterDropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleClickAway = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [open]);

  const toggleValue = (value: string): void => {
    const next = new Set(selected);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onChange(next);
  };

  if (options.length === 0) {
    return <></>;
  }

  return (
    <div className="filter-dropdown" ref={containerRef}>
      <button
        aria-expanded={open}
        className="filter-trigger"
        data-active={selected.size > 0}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {label}
        {selected.size > 0 ? <span className="filter-trigger-count">{selected.size}</span> : null}
        <Icon name="chevron-down" size={13} />
      </button>

      {open ? (
        <div className="filter-panel" role="menu">
          {options.map((option) => (
            <label className="filter-option" key={option.value}>
              <input
                checked={selected.has(option.value)}
                onChange={() => toggleValue(option.value)}
                type="checkbox"
              />
              <span className="filter-option-label">{option.value}</span>
              <span className="filter-option-count">{option.count}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
