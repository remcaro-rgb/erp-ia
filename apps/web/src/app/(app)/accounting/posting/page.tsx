import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { isPostingTab, loadPostingPage, type PostingPageData } from "@/lib/accounting/posting";
import { GridRoute } from "../../_components/grid-route";
import { ConceptsPanel } from "./concepts-panel";
import { MappingTable } from "./mapping-table";
import { PendingTable } from "./pending-table";
import { SettingsForm } from "./settings-form";

// Reglas contables (accounting design §5.4, §5.5, §5.9, §8): the rules, the account each role posts to, the exógena concepts, the inbox
// of events that could not post and the settings of the ledger. The tab is in the address (`?tab=`), so each is a page of its own.
async function Posting({ searchParams }: { searchParams: Promise<{ tab?: string; format?: string; year?: string }> }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const query = await searchParams;
  const t = await getTranslations("accounting.pages.posting");
  let data: PostingPageData;
  try {
    const year = Number(query.year);
    data = await loadPostingPage(await requireCaller(), isPostingTab(query.tab) ? query.tab : "rules", {
      ...(query.format ? { format: query.format } : {}),
      ...(Number.isInteger(year) && year >= 2000 && year <= 2100 ? { year } : {}),
    });
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  if (data.tabs.length === 0) return <p className="erp-muted">{t("none")}</p>;

  return (
    <div className="erp-stack">
      <nav className="erp-tabs-links" aria-label={t("tabs")}>
        {data.tabs.map((tab) => (
          <Link key={tab} href={`/accounting/posting?tab=${tab}`} aria-current={tab === data.tab ? "page" : undefined}>
            {t(`tab.${tab}`)}
            {tab === "pending" && data.pending > 0 ? <span className="erp-modbar-badge">{data.pending}</span> : null}
          </Link>
        ))}
      </nav>
      {data.tab === "rules" && <GridRoute entity="accounting.posting_rule" href="/accounting/posting?tab=rules" />}
      {data.tab === "mapping" && data.lookup && <MappingTable rows={data.mapping ?? []} unmapped={data.unmapped ?? []} lookup={data.lookup} canEdit={data.can.mapping} />}
      {data.tab === "concepts" && (data.concepts ? <ConceptsPanel data={data.concepts} lookup={data.lookup} canEdit={data.can.concepts} /> : <p className="erp-muted">{t("concepts_none")}</p>)}
      {data.tab === "pending" && <PendingTable failures={data.failures ?? []} can={data.can} today={new Date().toISOString().slice(0, 10)} />}
      {data.tab === "settings" && (data.settings ? <SettingsForm settings={data.settings} canEdit={data.can.settings} /> : <p className="erp-muted">{t("settings_none")}</p>)}
    </div>
  );
}

export default function PostingPage({ searchParams }: { searchParams: Promise<{ tab?: string; format?: string; year?: string }> }) {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Posting searchParams={searchParams} />
    </Suspense>
  );
}
