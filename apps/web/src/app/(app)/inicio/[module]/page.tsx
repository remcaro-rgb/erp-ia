import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getCallerClaims, redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadModuleHome } from "@/lib/home/load";
import { loadShellOnce } from "@/lib/shell/load";
import { ModuleHomeScreen } from "../../_components/module-home-screen";

// "/inicio/<module>": the Inicio of one module, inside the application shell (design §19a). The module must be one the shell offers
// the caller (entitled, with a screen they may open); its indicators and charts are read as the caller through `kernel.home.kpis`.

async function ModuleHomeView({ params }: { params: Promise<{ module: string }> }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const { module } = await params;
  let claims;
  let data;
  try {
    claims = await getCallerClaims();
    const shell = await loadShellOnce();
    if (!shell.modules.some((m) => m.id === module)) notFound();
    data = await loadModuleHome(shell, { claims, origin: "ui" }, module);
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return <ModuleHomeScreen data={data} userId={claims.sub} companyId={claims.active_company_id} />;
}

export default function ModuleHomePage({ params }: { params: Promise<{ module: string }> }) {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <ModuleHomeView params={params} />
    </Suspense>
  );
}
