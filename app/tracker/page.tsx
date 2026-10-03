import { Suspense } from "react";

import { IdentityRequired } from "@/components/IdentityRequired";
import { TrackerListSkeleton } from "@/components/tracker/TrackerList";
import { TrackerWorkspace } from "@/components/tracker/TrackerWorkspace";
import { WebMcpProvider } from "@/components/webmcp/WebMcpProvider";
import { getCurrentIdentity } from "@/lib/currentIdentity";

import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Escalation tracker · TS Dashboard",
};

/**
 * Server shell for the escalation tracker. Everything below the identity
 * check is client-side (src/components/tracker/*) because the workspace is
 * one interactive surface - views, list/board, detail panel - fed by the
 * /api/tracker routes, which also refuse unidentified browsers.
 */
export default async function TrackerPage(): Promise<React.ReactElement> {
  const identity = await getCurrentIdentity();

  if (!identity) {
    return (
      <>
        <div className="page-header-row">
          <div className="page-title-group">
            <h1 className="page-title">Escalation tracker</h1>
            <p className="page-subtitle">
              Every High/Critical Support Ticket and everything waiting on engineering: how it got escalated, its Slack conversations, SLA and
              linked CPs.
            </p>
          </div>
        </div>
        <IdentityRequired itemsLabel="escalations" />
      </>
    );
  }

  return (
    <>
      {/* Browser-agent page tools (WebMCP) for this identified person; a no-op in browsers without the API. */}
      <WebMcpProvider accountId={identity.accountId} />
      {/* useSearchParams in the workspace needs a Suspense boundary; the fallback is the same skeleton the list shows while loading. */}
      <Suspense
        fallback={
          <div className="trk-workspace">
            <div className="trk-center">
              <TrackerListSkeleton />
            </div>
          </div>
        }
      >
        <TrackerWorkspace />
      </Suspense>
    </>
  );
}
