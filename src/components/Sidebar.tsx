import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/Icon";

interface NavItem {
  href: string;
  icon: IconName;
  label: string;
}

interface NavGroup {
  items: NavItem[];
  label: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/", icon: "grid", label: "Dashboard" },
      { href: "/backlog", icon: "layers", label: "Team Sheet Backlog" },
      { href: "/weekly-closures", icon: "chart", label: "Weekly Closures" },
    ],
    label: "Overview",
  },
  {
    items: [
      { href: "/category/actionable", icon: "layers", label: "Actionable Items" },
      { href: "/category/waiting-product", icon: "wrench", label: "Waiting for Product" },
      { href: "/category/waiting-client", icon: "clock", label: "Waiting for Client" },
      { href: "/category/waiting-operations", icon: "gear", label: "Waiting for Operations" },
    ],
    label: "Issues",
  },
  {
    items: [
      { href: "/agent-followups", icon: "bot", label: "Agent Follow-Ups" },
      { href: "/sheet-followups", icon: "bot", label: "Sheet AI Follow-Ups" },
      { href: "/sla-followups", icon: "alert", label: "SLA Follow-Ups" },
      { href: "/closure-candidates", icon: "check-circle", label: "Closure Candidates" },
      { href: "/history", icon: "history", label: "History" },
    ],
    label: "Operations",
  },
  {
    items: [{ href: "/settings/jira-tokens", icon: "gear", label: "Jira Tokens" }],
    label: "Settings",
  },
];

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ collapsed, mobileOpen, onToggleCollapse }: SidebarProps): React.ReactElement {
  const pathname = usePathname();

  return (
    <aside
      className="app-sidebar"
      data-collapsed={collapsed}
      data-mobile-open={mobileOpen}
    >
      <div className="sidebar-header">
        <Link className="sidebar-brand" href="/">
          <span className="sidebar-brand-mark" aria-hidden="true">TS</span>
          <span className="sidebar-brand-label">Ops Console</span>
        </Link>
        <button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          type="button"
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={14} />
        </button>
      </div>

      <nav aria-label="Main navigation" className="sidebar-nav">
        {NAV_GROUPS.map((group) => (
          <div className="sidebar-group" key={group.label}>
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={active ? "sidebar-link active" : "sidebar-link"}
                  href={item.href}
                  key={item.href}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="sidebar-link-icon">
                    <Icon name={item.icon} />
                  </span>
                  <span className="sidebar-link-label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
