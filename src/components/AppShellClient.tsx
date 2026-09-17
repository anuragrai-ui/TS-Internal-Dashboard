"use client";

import { useEffect, useState } from "react";

import { Sidebar } from "@/components/Sidebar";
import { TopHeader } from "@/components/TopHeader";

const STORAGE_KEY = "ts-dashboard-sidebar-collapsed";

interface AppShellClientProps {
  children: React.ReactNode;
  jiraBaseUrl: string;
  userDisplayName: string | null;
}

export function AppShellClient({
  children,
  jiraBaseUrl,
  userDisplayName,
}: AppShellClientProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  const toggleCollapse = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapse={toggleCollapse}
      />
      {mobileOpen ? (
        <div
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
          style={{ background: "rgba(9, 30, 66, 0.36)", inset: 0, position: "fixed", zIndex: 45 }}
        />
      ) : null}

      <div className="app-main-col">
        <TopHeader
          jiraBaseUrl={jiraBaseUrl}
          onMenuClick={() => setMobileOpen((prev) => !prev)}
          userDisplayName={userDisplayName}
        />
        <main className="app-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
