"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createBrowserDeps } from "@/lib/webmcp/browser";
import { getModelContext, registerPageTools } from "@/lib/webmcp/registry";
import { buildPageTools } from "@/lib/webmcp/tools";

import type { RegistrationSummary } from "@/lib/webmcp/registry";

/* Mirrored on <body data-webmcp="..."> so "are the tools there?" is answerable from devtools. */
type WebMcpState = "off" | "on" | "partial" | "registering" | "unsupported";

function markBody(state: WebMcpState | null, toolCount?: number): void {
  const { dataset } = document.body;
  if (state === null) {
    delete dataset.webmcp;
    delete dataset.webmcpTools;
    return;
  }
  dataset.webmcp = state;
  if (toolCount === undefined) {
    delete dataset.webmcpTools;
  } else {
    dataset.webmcpTools = String(toolCount);
  }
}

function summaryMessage(summary: RegistrationSummary): string {
  const count = summary.registered.length;
  const failed = summary.failed.length > 0 ? ` ${summary.failed.length} couldn't be registered.` : "";
  return `Browser agent tools are on for this page (${count}). They can read, draft and propose; nothing is sent or changed without you.${failed}`;
}

/**
 * Exposes the tracker's page tools (src/lib/webmcp/tools.ts) to a browser
 * agent through WebMCP, for as long as this identified person is on the
 * page. Mounted only for an identified browser (app/tracker/page.tsx).
 *
 * - No WebMCP in this browser: does nothing (body says data-webmcp="unsupported").
 * - Unmount, or a different identity: the registration's signal aborts, which
 *   unregisters every tool before the next registration starts.
 * - Identity lost (any tool call answered 401): the tools are withdrawn and
 *   stay off until the page is reloaded as an identified person.
 *
 * Renders nothing visible: one visually hidden status line tells
 * screen-reader users the tools are on and what the agent just did.
 */
export function WebMcpProvider({ accountId }: { accountId: string }): React.ReactElement {
  const router = useRouter();
  const routerRef = useRef(router);
  /* Registrations run one after another, so an old one's cleanup can never remove a newer one's tools (same names). */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    if (lostFor === accountId) {
      markBody("off");
      return () => markBody(null);
    }
    const context = getModelContext();
    if (!context) {
      markBody("unsupported");
      return () => markBody(null);
    }

    const controller = new AbortController();
    const deps = createBrowserDeps({
      announce: (text) => {
        if (!controller.signal.aborted) {
          setMessage(text);
        }
      },
      navigate: (url) => routerRef.current.push(url),
      onUnauthorized: () => {
        if (controller.signal.aborted) {
          return;
        }
        controller.abort();
        setLostFor(accountId);
        setMessage("Browser agent tools are off: this browser is no longer identified. Register your Jira token again, then reload.");
      },
    });

    markBody("registering");
    const registration = chain.current.then(() => registerPageTools(context, buildPageTools(deps), controller.signal));
    chain.current = registration.catch(() => undefined);
    void registration.then((summary) => {
      if (controller.signal.aborted) {
        return;
      }
      markBody(summary.failed.length > 0 ? "partial" : "on", summary.registered.length);
      setMessage(summaryMessage(summary));
    });

    return () => {
      controller.abort();
      markBody(null);
    };
  }, [accountId, lostFor]);

  return (
    <p className="visually-hidden" role="status">
      {message}
    </p>
  );
}
