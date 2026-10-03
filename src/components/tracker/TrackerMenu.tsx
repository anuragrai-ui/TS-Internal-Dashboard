"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";

/* Breathing room kept between an open menu and the edge of the list it sits in. */
const EDGE_GUTTER_PX = 16;

interface TrackerMenuProps {
  active?: boolean;
  align?: "end" | "start";
  /* Rendered inside the trigger button. */
  buttonContent: React.ReactNode;
  buttonLabel: string;
  children: (close: () => void) => React.ReactNode;
}

/**
 * A small popover menu (sort, filter facets). Closes on outside click and
 * Escape, and hands focus back to its trigger so keyboard users don't get
 * dropped at the top of the page.
 */
export function TrackerMenu({ active = false, align = "start", buttonContent, buttonLabel, children }: TrackerMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(align);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /* Measured before paint: if the panel would run past the edge on its preferred side, open it from the other side instead. */
  useLayoutEffect(() => {
    const container = containerRef.current;
    const panel = panelRef.current;
    if (!open || !container || !panel) {
      setPlacement(align);
      return;
    }
    const anchor = container.getBoundingClientRect();
    const bounds = container.closest(".trk-center")?.getBoundingClientRect();
    const left = Math.max(bounds?.left ?? 0, 0) + EDGE_GUTTER_PX;
    const right = Math.min(bounds?.right ?? Infinity, document.documentElement.clientWidth) - EDGE_GUTTER_PX;
    const width = panel.offsetWidth;
    if (align === "start") {
      setPlacement(anchor.left + width > right ? "end" : "start");
    } else {
      setPlacement(anchor.right - width < left ? "start" : "end");
    }
  }, [align, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        /* Escape here closes the menu only, not the detail panel behind it. */
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="trk-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={buttonLabel}
        className="trk-menu-trigger"
        data-active={active}
        onClick={() => setOpen((previous) => !previous)}
        ref={triggerRef}
        type="button"
      >
        {buttonContent}
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div className="trk-menu-panel" data-align={placement} ref={panelRef}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
