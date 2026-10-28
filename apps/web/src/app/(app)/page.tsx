import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { getCallerClaims, redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { signOut } from "@/lib/auth/actions";

// "/" after sign-in, inside the application shell. Placeholder until the home dashboard (Task 20) fills it.

async function HomeView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  try {
    await getCallerClaims();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const t = await getTranslations("auth");
  return (
    <section className="flex w-full max-w-3xl flex-col gap-4" data-testid="home">
      <h1 className="text-2xl font-semibold">{t("home.title")}</h1>
      <form action={signOut}>
        <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">
          {t("home.sign_out")}
        </button>
      </form>
    </section>
  );
}

export default function HomePage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <HomeView />
    </Suspense>
  );
}
