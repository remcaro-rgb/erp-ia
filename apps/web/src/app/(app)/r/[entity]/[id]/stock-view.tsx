"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DataGrid, emptyFoundRow, foundRowInput, foundRowMissing, Pill, RecordLink, splitFoundMessages, StepUpPrompt, type CodeOption, type FoundRow, type LookupSource } from "@erp/ui";
import type { ReactNode } from "react";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { runStockStepAction } from "@/lib/inventory/actions";
import type { StockStep, StockView } from "@/lib/inventory/record";
import { FoundRows } from "./count-found";

// The Datos tab of a stored movimiento, traslado, conteo or costo en destino (plan 2B Task 10): its facts (references link to their
// records, rule 21), its stage, its lines in the universal grid (rule 20) and the steps of its process the caller may run now:
// Despachar and Recibir a traslado; Registrar conteo and Aplicar conteo (step-up, rule 15) a conteo, which then links to its ajuste.
// The record never changes otherwise: Anular is the bar's. An open conteo's sheet also takes what the counter found that it does not list
// («Agregar encontrado», Task 28.5): a lot (one of the product's, or a new code with its expiry) or a serial scanned, sent with «Registrar
// conteo» as `found`; the process's refusals show on the row they name.

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="erp-sec">
      <h3>
        {title}
        {extra && <> {extra}</>}
      </h3>
      {children}
    </section>
  );
}

const STAGE_TONE: Record<string, "ok" | "warn" | "info" | "gray"> = { requested: "info", in_transit: "warn", received: "ok", open: "info", applied: "ok" };

export function StockRecordView({ entity, recordId, view, product, locations = [] }: { entity: string; recordId: string; view: StockView; product?: LookupSource; locations?: readonly CodeOption[] }) {
  const t = useTranslations("inventory.view");
  const tf = useTranslations("inventory.count.found");
  const te = useTranslations("errors");
  // Lots and serials (Task 28.2): the column shows only when the count holds a tracked product.
  const tracked = view.countLines.some((l) => l.lotSerial !== "");
  const router = useRouter();
  const [found, setFound] = useState<FoundRow[]>([]);
  // The action takes the entity and the step's name; it picks the process itself (plan 2B Task 14b). After «Registrar conteo» the found
  // rows are lines of the sheet: the form starts over.
  const step = useStepRunner(
    (step: StockStep, input, token) => runStockStepAction(entity, step.slice(step.lastIndexOf(".") + 1), input, token),
    () => {
      setFound([]);
      router.refresh();
    },
  );
  const countedOf = () => Object.fromEntries(view.countLines.map((l) => [l.id, l.countedQty === null ? "" : String(l.countedQty)]));
  const [counted, setCounted] = useState<Record<string, string>>(countedOf);
  // A refreshed sheet (lines recorded, found rows added) shows what the server holds.
  const sheetKey = view.countLines.map((l) => `${l.id}:${l.countedQty ?? ""}`).join("|");
  const [seenSheet, setSeenSheet] = useState(sheetKey);
  if (seenSheet !== sheetKey) {
    setSeenSheet(sheetKey);
    setCounted(countedOf());
  }
  const isCount = entity === "inventory.count";
  const canRecord = view.steps.includes("inventory.count.record");
  const canFind = canRecord && view.found !== null;
  const findTracking = view.found?.tracking ?? {};
  const findLots = view.found?.lots ?? {};
  const foundReady = found.length > 0 && found.every((r) => foundRowMissing(r).length === 0);
  const record = () => {
    const lines = view.countLines
      .filter((l) => counted[l.id]?.trim())
      .map((l) => ({ lineId: l.id, countedQty: Number(counted[l.id]!.trim().replace(",", ".")) }));
    step.run("inventory.count.record", { id: recordId, lines, ...(found.length > 0 ? { found: found.map(foundRowInput) } : {}) });
  };
  const setRow = (key: string, patch: Partial<FoundRow>) => setFound((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = (from?: FoundRow) =>
    setFound((rows) => [...rows, from ? { ...emptyFoundRow(), productId: from.productId, productLabel: from.productLabel, tracking: from.tracking, locationId: from.locationId } : emptyFoundRow()]);
  const split = step.failure && found.length > 0 ? splitFoundMessages(step.failure.messages, found) : null;
  const sheetMessages = split ? split.rest : (step.failure?.messages ?? []);
  const stageId = isCount ? "count-stage" : "transfer-stage";
  const failureText = step.failure ? (sheetMessages.length > 0 ? sheetMessages.join(" · ") : split ? null : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;

  return (
    <div className="erp-form">
      <Section title={t("facts")} extra={view.stage ? <span data-testid={stageId}><Pill tone={STAGE_TONE[view.stage] ?? "gray"}>{view.stageLabel ?? view.stage}</Pill></span> : undefined}>
        <div className="erp-form2">
          {view.facts.map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": f.testId } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.link ? <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} /> : <span className={f.mono ? "erp-mono" : undefined}>{f.value}</span>}
            </div>
          ))}
          {view.adjustment && (
            <div className="erp-field">
              <span className="erp-field__label">{t("adjustment")}</span>
              <RecordLink entity="inventory.movement" id={view.adjustment.id} label={view.adjustment.number} mono />
            </div>
          )}
        </div>
      </Section>

      {isCount && (
        <Section title={t("count_sheet")}>
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("count_sheet")}>
              <thead>
                <tr>
                  <th scope="col" className="erp-lines__no">
                    #
                  </th>
                  <th scope="col">{t("product")}</th>
                  <th scope="col">{t("location")}</th>
                  {tracked && <th scope="col">{t("lot_serial")}</th>}
                  <th scope="col" className="erp-num">
                    {t("system_qty")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("counted_qty")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("difference")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.countLines.map((l) => (
                  <tr key={l.id}>
                    <td className="erp-lines__no erp-muted">{l.lineNo}</td>
                    <td>{l.product}</td>
                    <td>{l.location || "—"}</td>
                    {tracked && <td className="erp-mono">{l.lotSerialLink ? <RecordLink entity={l.lotSerialLink.entity} id={l.lotSerialLink.id} label={l.lotSerial} mono inRow /> : l.lotSerial || "—"}</td>}
                    <td className="erp-num erp-mono">{l.systemQty ?? "—"}</td>
                    <td className="erp-num">
                      {canRecord ? (
                        <input aria-label={t("counted_line", { n: l.lineNo })} className="erp-num erp-mono" inputMode="decimal" value={counted[l.id] ?? ""} onChange={(e) => setCounted((c) => ({ ...c, [l.id]: e.target.value }))} />
                      ) : (
                        <span className="erp-mono">{l.countedQty ?? "—"}</span>
                      )}
                    </td>
                    <td className="erp-num erp-mono" data-testid={`count-difference-${l.lineNo}`}>
                      {l.difference ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.stage === "open" && <p className="erp-small erp-muted">{t("count_hint")}</p>}
          {canFind && (
            <FoundRows rows={found} product={product} locations={locations} tracking={findTracking} lots={findLots} errors={split?.rows ?? {}} busy={step.busy} onChange={setRow} onAdd={addRow} onRemove={(key) => setFound((rows) => rows.filter((r) => r.key !== key))} />
          )}
          {canFind && found.length === 0 && (
            <div className="erp-row">
              <button type="button" className="erp-btn" disabled={step.busy} onClick={() => addRow()}>
                {tf("add")}
              </button>
              <span className="erp-small erp-muted">{tf("hint")}</span>
            </div>
          )}
        </Section>
      )}

      {view.linesGrid && !isCount && (
        <DataGrid entity={view.linesGrid.entity} title={view.linesGrid.title} columns={view.linesGrid.columns} baseFilters={view.linesGrid.filters} initialState={{ sort: [{ field: "line_no", dir: "asc" }] }} />
      )}

      {failureText && (
        <div className="erp-dian erp-dian--bad" role="alert">
          <b>{failureText}</b>
        </div>
      )}
      {view.steps.length > 0 && (
        <div className="erp-form__actions">
          {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {step.busy ? t("working") : ""}
            </span>
            {view.steps.includes("inventory.transfer.ship") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("inventory.transfer.ship", { id: recordId })}>
                {t("ship")}
              </button>
            )}
            {view.steps.includes("inventory.transfer.receive") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("inventory.transfer.receive", { id: recordId })}>
                {t("receive")}
              </button>
            )}
            {canRecord && (
              <button type="button" className="erp-btn" disabled={step.busy || (found.length > 0 ? !foundReady : !Object.values(counted).some((v) => v.trim() !== ""))} onClick={record}>
                {t("record_count")}
              </button>
            )}
            {view.steps.includes("inventory.count.apply") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy || found.length > 0 || view.countLines.some((l) => l.countedQty === null)} title={t("apply_hint")} onClick={() => step.run("inventory.count.apply", { id: recordId })}>
                {t("apply_count")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

