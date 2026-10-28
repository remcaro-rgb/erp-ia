import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getCallerClaims, redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadHome } from "@/lib/home/load";
import { loadShellOnce } from "@/lib/shell/load";
import { HomeScreen } from "./_components/home-screen";

// "/" after sign-in, inside the application shell: the greeting and the widget dashboard (design §19a). The data is read as
// the caller through registered processes; the dashboard itself is a client component.

async function HomeView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let claims;
  let data;
  try {
    claims = await getCallerClaims();
    data = await loadHome(await loadShellOnce(), { claims, origin: "ui" });
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return <HomeScreen data={data} userId={claims.sub} companyId={claims.active_company_id} />;
}

export default function HomePage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <HomeView />
    </Suspense>
  );
}
