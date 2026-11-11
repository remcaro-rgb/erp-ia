import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { loadNestedFailures } from "@/lib/nested/load";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { ForbiddenInShell } from "../_components/forbidden-view";
import { FailuresScreen } from "./failures-screen";

// Fallos de ejecuciones anidadas (plan 2B Task 32, R32-12): outside /admin so a role granted the retry can open it; the loader answers null to anyone else.
export default function NestedFailuresPage() {
  return (
    <Suspense fallback={null}>
      <FailuresRoute />
    </Suspense>
  );
}

async function FailuresRoute() {
  // Session data: keep it out of prerendering.
  await connection();
  let data;
  try {
    data = await loadNestedFailures();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (data === null) return <ForbiddenInShell />;
  return <FailuresScreen data={data} />;
}
