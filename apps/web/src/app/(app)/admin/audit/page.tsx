import { Suspense } from "react";
import { loadAudit } from "@/lib/admin/load";
import { AdminRoute } from "../_components/admin-route";
import { AuditScreen } from "./audit-screen";

// Auditoría (design §5.9, §6, rule 16, prototype v5 renderAudit): the company's append-only audit log as a grid with its
// origin, process, record, actor and causal chain; filters, advanced filter, saved views and export. The company admin
// only (kernel.audit.consult and kernel.v_audit_entries).
export default function AuditPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <AdminRoute load={loadAudit} render={(data) => <AuditScreen data={data} />} />
    </Suspense>
  );
}
