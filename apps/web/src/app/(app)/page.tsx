import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getCallerClaims, redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { signOut } from "@/lib/auth/actions";
import { authCopy } from "@/lib/auth/copy";

// "/" after sign-in. Placeholder until the application shell (Task 12) takes this route.

async function HomeView() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  try {
    await getCallerClaims();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6" data-testid="home">
      <h1 className="text-2xl font-semibold">{authCopy.home.title}</h1>
      <form action={signOut}>
        <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">
          {authCopy.home.signOut}
        </button>
      </form>
    </main>
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
