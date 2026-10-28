import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionState, mfaStep } from "@/lib/auth/claims";
import { Brand } from "../../_components/brand";
import { EnrollForm } from "../../_components/enroll-form";

// /mfa/enroll: first TOTP factor of an account whose role requires one. Reachable only with a password session.

async function EnrollView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const state = await getSessionState();
  if (!state) redirect("/login");
  if (state.mfaEnrolled) redirect(mfaStep(state) === "verify" ? "/mfa/verify" : "/");
  return <EnrollForm />;
}

export default function EnrollPage() {
  return (
    <>
      <Brand />
      <Suspense fallback={null}>
        <EnrollView />
      </Suspense>
    </>
  );
}
