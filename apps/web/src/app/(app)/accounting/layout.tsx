import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { isConfigured } from "@/lib/accounting/setup";
import { SetupGate } from "./setup/setup-gate";

// Every accounting page needs the company to have run Configurar contabilidad (accounting design §5.9): until `settings` has a row the
// pages lead to the single setup action. The layout reads that once; the gate sends a page other than the setup to it.
async function Gate({ children }: { children: ReactNode }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let configured: boolean;
  try {
    configured = await isConfigured(await requireCaller());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return configured ? children : <SetupGate>{children}</SetupGate>;
}

export default function AccountingLayout({ children }: { children: ReactNode }) {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
