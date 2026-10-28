import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadImportPage } from "@/lib/imports/load";
import { ImportPage } from "./import-page";

// "Importar datos" (design §9, prototype `renderImportPage`): one card per entity the caller may import into and the
// company's import history.

async function ImportRoute() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let data;
  try {
    data = await loadImportPage();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return <ImportPage data={data} />;
}

export default function ImportDataPage() {
  return (
    <Suspense fallback={null}>
      <ImportRoute />
    </Suspense>
  );
}
