import Link from "next/link";

import { Icon } from "@/components/Icon";

interface IdentityRequiredProps {
  /** What this tab would otherwise show, e.g. "CP escalations", "SLA follow-ups" - used only to tailor the copy. */
  itemsLabel: string;
}

/**
 * Shown on every Operations tab in place of the normal empty-state when
 * nobody has identified this browser yet (see src/lib/currentIdentity.ts).
 * Deliberately distinct from "you're identified, but you have nothing due
 * right now" - that's still the existing plain empty-state div on each page.
 */
export function IdentityRequired({ itemsLabel }: IdentityRequiredProps): React.ReactElement {
  return (
    <div className="empty-state" style={{ alignItems: "center", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <Icon name="user" size={22} />
      <span>
        Enter your Jira API key to see your own {itemsLabel} here - this tab only shows tickets assigned to
        you once you're identified.
      </span>
      <Link className="btn" href="/settings/jira-tokens">
        Go to Jira Tokens
      </Link>
    </div>
  );
}
