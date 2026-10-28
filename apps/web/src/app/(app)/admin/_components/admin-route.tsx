import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";

/**
 * An administration screen: loads its data as the caller (session data, so outside prerendering) and renders it, or
 * says the caller may not administer the company (the loaders answer null to anyone but the company admin).
 */
export async function AdminRoute<T>({ load, render }: { load: () => Promise<T | null>; render: (data: T) => ReactNode }) {
  await connection();
  let data: T | null;
  try {
    data = await load();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (data === null) {
    const t = await getTranslations();
    return (
      <div role="alert" className="erp-card erp-stack" style={{ padding: 20 }}>
        <b>{t("common.admin.forbidden_title")}</b>
        <span className="erp-small erp-muted">{t("common.admin.forbidden_body")}</span>
      </div>
    );
  }
  return <>{render(data)}</>;
}
