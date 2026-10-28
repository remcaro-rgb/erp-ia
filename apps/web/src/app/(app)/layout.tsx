import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadShellOnce } from "@/lib/shell/load";
import { WebShell } from "./_components/web-shell";

// Every signed-in screen sits in the application shell (design §19a, rule 19). The layout reads, as the caller,
// what the shell may offer (entitled modules, permitted menu items and create commands) and the saved theme
// and tabs; the shell itself is a client component.

async function ShellView({ children }: { children: React.ReactNode }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let data;
  try {
    data = await loadShellOnce();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  // Keyed by company: after a switch the shell (pending saves, tabs, theme) starts over from that company's prefs.
  return (
    <WebShell key={data.company.id} data={data}>
      {children}
    </WebShell>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <ShellView>{children}</ShellView>
    </Suspense>
  );
}
