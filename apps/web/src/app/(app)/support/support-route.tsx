import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadSupportPage } from "@/lib/support/load";
import { SupportScreen } from "./support-screen";

/** The body of the support screen, read as the caller; a screen the caller may not open says why. */
export async function SupportRoute() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let result;
  try {
    result = await loadSupportPage();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (!result.ok) {
    const t = await getTranslations("grid.denied");
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(result.denial)}
      </div>
    );
  }
  return <SupportScreen data={result.data} />;
}
