import { callerOrResponse } from "@/lib/auth/http";
import { saveShellPref } from "@/lib/prefs/save";
import { parseShellPref } from "@/lib/prefs/validate";

// POST /api/prefs  { key, value, savedAt }  ->  204
// The shell's last pending preference save, sent with `navigator.sendBeacon` on `pagehide` (a server action
// cannot outlive the page). Same validation and process as the server action. Same-origin JSON only.

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ code: "forbidden", details: null }, { status: 403 });
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return Response.json({ code: "invalid_input", details: ["application/json expected"] }, { status: 415 });
  }
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;

  const pref = parseShellPref(await request.json().catch(() => null));
  if (!pref) return Response.json({ code: "invalid_input", details: null }, { status: 400 });
  return (await saveShellPref(caller, pref)) ? new Response(null, { status: 204 }) : Response.json({ code: "forbidden", details: null }, { status: 403 });
}

/** The request comes from a page of this host (the beacon always sends `Origin`; a missing one is refused). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
