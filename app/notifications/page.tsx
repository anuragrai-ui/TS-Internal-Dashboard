import Link from "next/link";

import { Icon } from "@/components/Icon";
import { IdentityRequired } from "@/components/IdentityRequired";
import { NotificationCenter } from "@/components/NotificationCenter";
import { getCurrentIdentity } from "@/lib/currentIdentity";

export const dynamic = "force-dynamic";

export default async function NotificationsPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();

  return (
    <>
      <Link className="back-link" href="/">
        <Icon name="chevron-left" size={14} />
        Back to dashboard
      </Link>

      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Notifications</h1>
          <p className="page-subtitle">
            What changed on your tickets. This covers Jira comments, customer replies, status moves and assignments on your TS tickets,
            engineering updates on the CPs they wait on, and replies and reactions in the Slack threads the dashboard started. New items also pop
            up live in the bell. Kept for 14 days.
          </p>
        </div>
      </div>

      {identity ? <NotificationCenter /> : <IdentityRequired itemsLabel="notifications" />}
    </>
  );
}
