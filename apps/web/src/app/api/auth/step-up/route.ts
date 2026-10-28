import { callerOrResponse } from "@/lib/auth/http";
import { issueStepUp, StepUpError } from "@/lib/auth/step-up";
import { serverSupabase } from "@/lib/supabase/server";

// POST /api/auth/step-up  { code }  ->  { token }
// The user types a TOTP code; a correct one yields the token a sensitive process run presents
// (`Caller.stepUpToken`, valid 5 minutes, single use). The proxy leaves /api/auth/* open, so this handler
// authenticates the session itself.

const STATUS = { invalid_code: 401, no_factor: 409, unavailable: 503 } as const;

export async function POST(request: Request): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;

  const body: unknown = await request.json().catch(() => null);
  const code = typeof body === "object" && body !== null && "code" in body ? (body as { code: unknown }).code : undefined;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return Response.json({ code: "invalid_input", details: ["code must be 6 digits"] }, { status: 400 });
  }

  try {
    return Response.json({ token: await issueStepUp(await serverSupabase(), caller.claims, code) });
  } catch (error) {
    if (error instanceof StepUpError) return Response.json({ code: error.code, details: null }, { status: STATUS[error.code] });
    throw error;
  }
}
