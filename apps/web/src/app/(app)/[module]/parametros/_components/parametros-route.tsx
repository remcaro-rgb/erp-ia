import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { loadDestinatarios, loadPlantillas, loadTipos, PARAMETER_PAGES, type Loaded, type ParameterPage } from "@/lib/parametros/load";
import { DestinatariosScreen } from "./destinatarios-screen";
import { PlantillasScreen } from "./plantillas-screen";
import { TiposScreen } from "./tipos-screen";

// A module's Parámetros screen of the entity types (Task 16; KERNEL_PARAMETER_PAGES: /<module>/parametros/tipos|destinatarios|plantillas).
// The data is read as the caller (company admin only); anyone else sees that they may not administer, and the processes refuse them
// anyway (hiding is never the only guard). A module without maestros or documentos, or one the company does not use, has none.

const MODULE = /^[a-z][a-z0-9_]*$/;

async function forbidden(): Promise<ReactNode> {
  const t = await getTranslations();
  return (
    <div role="alert" className="erp-card erp-stack" style={{ padding: 20 }}>
      <b>{t("common.admin.forbidden_title")}</b>
      <span className="erp-small erp-muted">{t("common.admin.forbidden_body")}</span>
    </div>
  );
}

async function loaded<T>(load: () => Promise<Loaded<T>>): Promise<T | null> {
  try {
    const data = await load();
    if (data !== null && typeof data === "object" && "missing" in data) notFound();
    return data as T | null;
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
}

export async function ParametrosRoute({ params, moduleId }: { params: Promise<{ module?: string; page: string }>; moduleId?: string }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const resolved = await params;
  const moduleName = moduleId ?? resolved.module ?? "";
  const page = resolved.page as ParameterPage;
  if (!MODULE.test(moduleName) || !PARAMETER_PAGES.includes(page)) notFound();
  switch (page) {
    case "tipos": {
      const data = await loaded(() => loadTipos(moduleName));
      return data ? <TiposScreen data={data} /> : forbidden();
    }
    case "destinatarios": {
      const data = await loaded(() => loadDestinatarios(moduleName));
      return data ? <DestinatariosScreen data={data} /> : forbidden();
    }
    case "plantillas": {
      const locale = await getLocale();
      const data = await loaded(() => loadPlantillas(moduleName, locale));
      return data ? <PlantillasScreen data={data} /> : forbidden();
    }
  }
}
