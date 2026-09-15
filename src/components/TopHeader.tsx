"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";

const CATEGORY_TITLES: Record<string, string> = {
  actionable: "Actionable Items",
  "waiting-client": "Waiting for Client",
  "waiting-operations": "Waiting for Operations",
  "waiting-product": "Waiting for Product",
};

const SECTION_TITLES: Record<string, string> = {
  history: "History",
  "sla-followups": "SLA Follow-Ups",
};

function useBreadcrumb(): string[] {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return ["Dashboard"];
  }

  const [first, second] = segments;

  if (first === "category" && second) {
    return ["Dashboard", "Issues", CATEGORY_TITLES[second] ?? second];
  }

  if (first) {
    return ["Dashboard", SECTION_TITLES[first] ?? first];
  }

  return ["Dashboard"];
}

const TICKET_KEY_PATTERN = /^(TS|CP)-\d+$/i;

interface TopHeaderProps {
  jiraBaseUrl: string;
  onMenuClick: () => void;
  userDisplayName: string;
}

export function TopHeader({ jiraBaseUrl, onMenuClick, userDisplayName }: TopHeaderProps): React.ReactElement {
  const crumbs = useBreadcrumb();
  const [query, setQuery] = useState("");

  const initials = userDisplayName
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") {
      return;
    }

    const trimmed = query.trim();

    if (TICKET_KEY_PATTERN.test(trimmed) && jiraBaseUrl) {
      window.open(`${jiraBaseUrl}/browse/${trimmed.toUpperCase()}`, "_blank", "noreferrer");
      setQuery("");
    }
  };

  return (
    <header className="app-header">
      <button
        aria-label="Toggle navigation"
        className="header-menu-btn"
        onClick={onMenuClick}
        type="button"
      >
        <Icon name="menu" />
      </button>

      <div className="header-breadcrumb" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={crumb} style={{ alignItems: "center", display: "inline-flex", gap: "var(--space-2)" }}>
            {index > 0 ? <Icon name="chevron-right" size={12} /> : null}
            <span className={index === crumbs.length - 1 ? "crumb-current" : undefined}>{crumb}</span>
          </span>
        ))}
      </div>

      <div className="header-search">
        <span className="header-search-icon">
          <Icon name="search" size={15} />
        </span>
        <input
          aria-label="Jump to a ticket by key"
          className="header-search-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Jump to ticket (TS-12345, CP-12345)…"
          type="search"
          value={query}
        />
        <span className="header-search-hint">↵</span>
      </div>

      <div className="header-actions">
        <Link aria-label="Refresh Jira data" className="header-icon-btn" href="/refresh">
          <Icon name="refresh" />
        </Link>
        <ThemeToggle />
        <span aria-label={userDisplayName} className="user-badge" title={userDisplayName}>
          {initials || "?"}
        </span>
      </div>
    </header>
  );
}
