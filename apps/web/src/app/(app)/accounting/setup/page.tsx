import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { canConfigure, isConfigured } from "@/lib/accounting/setup";
import { SetupAction } from "./setup-action";

// Configurar contabilidad (accounting design §5.9): the first visit of a user who may run it. One action installs the country's chart, the
// role mappings, the fuentes, the fiscal year and the default posting rules; running it again only adds what is missing.
async function Setup() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const t = await getTranslations("accounting.pages.setup");
  let configured: boolean;
  let allowed = false;
  try {
    const caller = await requireCaller();
    configured = await isConfigured(caller);
    if (!configured) allowed = await canConfigure(caller);
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (configured) redirect("/accounting/entries");
  return (
    <section className="erp-card" style={{ maxWidth: 640 }}>
      <h2>{t("title")}</h2>
      <p>{t("body")}</p>
      {allowed ? (
        <SetupAction />
      ) : (
        <p role="status" className="erp-muted">
          {t("forbidden")}
        </p>
      )}
    </section>
  );
}

export default function SetupPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Setup />
    </Suspense>
  );
}
