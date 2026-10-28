import type { RequestStepUp } from "@erp/ui";

/** A TOTP code for the step-up endpoint (rule 15), from the browser: the token a sensitive process run presents. */
export const requestStepUp: RequestStepUp = async (code) => {
  const response = await fetch("/api/auth/step-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await response.json().catch(() => null)) as { token?: string; code?: string } | null;
  return response.ok && body?.token ? { token: body.token } : { error: body?.code ?? "unavailable" };
};
