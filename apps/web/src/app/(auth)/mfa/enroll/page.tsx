import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionState, mfaStep } from "@/lib/auth/claims";
import { Brand } from "../../_components/brand";
import { EnrollForm } from "../../_components/enroll-form";

// /mfa/enroll: first TOTP factor of an account whose role requires one, or of anyone who turns it on from the user menu
// (design §22.19). Reachable only with a password session. Only when it is not required may the user skip it.

async function EnrollView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const state = await getSessionState();
  if (!state) redirect("/login");
  if (state.mfaEnrolled) redirect(mfaStep(state) === "verify" ? "/mfa/verify" : "/");
  return <EnrollForm optional={!state.requiresMfa} />;
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
