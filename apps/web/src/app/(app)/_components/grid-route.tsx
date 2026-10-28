import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadGridPage } from "@/lib/grid/load";
import { GridPage } from "./grid-page";

/** The body of the grid page of `entity` at `href`, read as the caller; a page the caller may not open says why. */
export async function GridRoute({ entity, href }: { entity: string; href: string }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let result;
  try {
    result = await loadGridPage(entity, href);
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
  return <GridPage data={result.data} />;
}
