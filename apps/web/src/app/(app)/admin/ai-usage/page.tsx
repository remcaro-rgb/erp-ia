import { Suspense } from "react";
import { loadAiUsage } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { AiUsageScreen } from "./ai-usage-screen";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function UsageRoute({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const { month } = await searchParams;
  const wanted = typeof month === "string" && MONTH.test(month) ? month : undefined;
  return <AdminRoute load={() => loadAiUsage(wanted)} render={(data) => <AiUsageScreen data={data} />} />;
}

// Uso de IA: the month's tokens and cost per user and per model against the allowance (rule 27, prototype v5).
export default function AiUsagePage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  return (
    <Suspense fallback={null}>
      <UsageRoute searchParams={searchParams} />
    </Suspense>
  );
}
