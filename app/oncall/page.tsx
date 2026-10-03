import { IdentityRequired } from "@/components/IdentityRequired";
import { OnCallBoard } from "@/components/oncall/OnCallBoard";
import { getCurrentIdentity } from "@/lib/currentIdentity";

import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "On-call & firefighters · TS Dashboard",
};

/**
 * Server shell for the on-call page. Everything below the identity check is
 * client-side (src/components/oncall/OnCallBoard.tsx), fed by /api/oncall
 * (the firefighter rotation from Google Calendar), /api/google/status (the
 * calendar sign-in) and /api/firefighters (the #firefighters channel) - all
 * refuse unidentified browsers too.
 */
export default async function OnCallPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();

  return (
    <>
      <div className="page-header-row">
        <div className="page-title-group">
          <h1 className="page-title">On-call &amp; firefighters</h1>
          <p className="page-subtitle">
            Who is firefighter right now for Asia/Europe and the US, from the rotation&apos;s Google Calendar (read through a one-time
            Google sign-in - see the calendar card below), and what&apos;s happening in #firefighters.
          </p>
        </div>
      </div>
      {identity ? <OnCallBoard /> : <IdentityRequired itemsLabel="on-call schedule" />}
    </>
  );
}
