import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionState, mfaStep } from "@/lib/auth/claims";
import { Brand } from "../../_components/brand";
import { VerifyForm } from "../../_components/verify-form";

// /mfa/verify: the second step for an account with a verified TOTP factor. Reachable only with a password session.

async function VerifyView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const state = await getSessionState();
  if (!state) redirect("/login");
  const step = mfaStep(state);
  if (step === "enroll") redirect("/mfa/enroll");
  if (step === null) redirect("/");
  return <VerifyForm />;
}

export default function VerifyPage() {
  return (
    <>
      <Brand />
      <Suspense fallback={null}>
        <VerifyView />
      </Suspense>
    </>
  );
}
