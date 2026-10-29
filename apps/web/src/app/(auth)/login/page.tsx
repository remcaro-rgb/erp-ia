import { Suspense } from "react";
import { cookies } from "next/headers";
import { LoginForm } from "../_components/login-form";
import { Brand } from "../_components/brand";
import { REMEMBER_EMAIL_COOKIE } from "@/lib/supabase/cookies";

// /login: e-mail + password with "Recordarme en este dispositivo por 30 días". A remembered device comes back
// with the e-mail filled in (from the `erp.remember_email` cookie) and the box ticked.

async function LoginView({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [jar, { error }] = await Promise.all([cookies(), searchParams]);
  const email = jar.get(REMEMBER_EMAIL_COOKIE)?.value ?? "";
  // `key`: the fields are uncontrolled, so a changed prefill (a device just remembered or forgotten) needs a fresh form.
  return <LoginForm key={email} defaultEmail={email} defaultRemember={email !== ""} initialError={error === "no_company" || error === "account_disabled" ? error : null} />;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // Cookies and search params are request data: read them inside Suspense (cache components).
  return (
    <>
      <Brand />
      <Suspense fallback={null}>
        <LoginView searchParams={searchParams} />
      </Suspense>
    </>
  );
}
