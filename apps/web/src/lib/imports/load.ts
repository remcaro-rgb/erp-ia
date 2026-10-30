import "server-only";
import { getTranslations } from "next-intl/server";
import { flattenNav, ProcessError, runnableProcesses, runProcess, type Caller } from "@erp/kernel";
import type { ImportHistoryItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { importScreenProcesses, importScreens, type ImportScreen } from "./screens";

// What the import page (/import) needs, read as the caller: the entities they may import into, with the screen
// names, and the company's import history (kernel.import.list).

export interface ImportPageData {
  screens: (ImportScreen & { title: string })[];
  /** Screen name of each importable entity id, for the history. */
  titles: Record<string, string>;
  history: ImportHistoryItem[];
}

/** The history the caller may read; none when their role may not list imports. */
async function history(caller: Caller): Promise<ImportHistoryItem[]> {
  try {
    return await runProcess(processDeps(), caller, "kernel.import.list", {});
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

export async function loadImportPage(): Promise<ImportPageData> {
  const caller = await requireCaller();
  const deps = processDeps();
  const [runnable, items, t] = await Promise.all([runnableProcesses(deps.sql, deps.registry, caller.claims, importScreenProcesses()), history(caller), getTranslations()]);
  const navLabel = (href: string, fallback: string) =>
    deps.registry
      .modules()
      .flatMap((m) => flattenNav([...m.navigation, ...m.features.flatMap((f) => f.nav ?? [])]))
      .find((item) => item.href === href)?.label ?? fallback;
  const screens = importScreens(deps.registry, runnable).map((s) => ({ ...s, title: t(navLabel(s.href, deps.registry.entity(s.entity).label)) }));
  return { screens, titles: Object.fromEntries(screens.map((s) => [s.entity, s.title])), history: items };
}
