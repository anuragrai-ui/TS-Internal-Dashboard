import { NextResponse } from "next/server";

/**
 * Cross-site request guard for the write routes. The identity cookie is
 * SameSite=Lax, which already keeps it off cross-site POSTs from modern
 * browsers; this is the second lock for everything Lax doesn't cover (an
 * older browser, a same-site sibling subdomain, a future cookie change).
 *
 * Browsers send Origin on every POST fetch, so: when it's present it must
 * name this host. When it's absent (curl, a server-side caller with the
 * cookie) there's no browser to forge anything and the request goes through.
 */

/** True unless the request carries an Origin for a different host than it was sent to. Pure. */
export function isSameOriginRequest(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (origin === null) {
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    /* "null" (a sandboxed frame, a file: page) or garbage - never this app. */
    return false;
  }
  const hosts = [headers.get("host"), headers.get("x-forwarded-host")]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return hosts.includes(originHost);
}

/** For POST handlers: a 403 to return as-is when the request came from another site, else null. */
export function rejectCrossOrigin(request: Request): NextResponse | null {
  if (isSameOriginRequest(request.headers)) {
    return null;
  }
  return NextResponse.json({ error: "Cross-site requests can't change tickets." }, { headers: { "Cache-Control": "no-store" }, status: 403 });
}
