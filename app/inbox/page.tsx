import { IdentityRequired } from "@/components/IdentityRequired";
import { InboxWorkspace } from "@/components/inbox/InboxWorkspace";
import { getCurrentIdentity } from "@/lib/currentIdentity";

import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Email inbox · TS Dashboard",
};

/**
 * Server shell for the support inbox. Everything below the identity check
 * is client-side (src/components/inbox/InboxWorkspace.tsx), fed by
 * /api/email/* and the shared /api/actions route for replies - all of which
 * refuse unidentified browsers too.
 */
export default async function InboxPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();

  return (
    <>
      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">Email inbox</h1>
          <p className="page-subtitle">
            Customer email to the support mailbox, as cases: link a thread to its TS ticket, or reply from the support address. Messages are
            shown as plain text.
          </p>
        </div>
      </div>
      {identity ? <InboxWorkspace /> : <IdentityRequired itemsLabel="support inbox" />}
    </>
  );
}
