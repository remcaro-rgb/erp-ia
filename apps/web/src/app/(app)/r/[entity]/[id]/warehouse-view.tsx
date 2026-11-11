"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Pill, RecordLink, StepUpPrompt, useTabs } from "@erp/ui";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { runWarehouseStepAction, type WarehouseOutcome } from "@/lib/warehouse/actions";
import type { PickLineView, WarehouseView } from "@/lib/warehouse/record";

// The Datos tab of a stored alistamiento or empaque (plan 2B.2 Task 29.4, PG §4.3 steps 2 and 6): its facts (references link to their
// records, rule 21), its stage and its lines, and the steps the caller may run now. An alistamiento: «Iniciar» hands it to the picker; each
// line says where it was taken from (a bucket of its product in the bodega: ubicación, lot, serial) and how much; «Guardar» keeps what was
// typed, «Confirmar alistamiento» sends it to inventory (a line left untouched is taken as proposed, owner item 217); a confirmed one may be
// packed («Crear empaque»). An empaque: the weight and measures of each package, «Guardar paquetes», «Cerrar empaque». Anular is the bar's.

type Step = "start" | "update" | "confirm" | "pack" | "close";

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

const STAGE_TONE: Record<string, "ok" | "warn" | "info" | "gray"> = { open: "info", in_progress: "warn", confirmed: "ok", closed: "ok" };
const qtyText = (n: number | null) => (n === null ? "—" : new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 }).format(n));
const parse = (s: string): number | null => {
  const v = s.trim().replace(",", ".");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};

interface Draft {
  sourceKey: string;
  qty: string;
}

export function WarehouseRecordView({ entity, recordId, view }: { entity: string; recordId: string; view: WarehouseView }) {
  const t = useTranslations("warehouse.view");
  const te = useTranslations("errors");
  const router = useRouter();
  const open = useTabs((s) => s.open);
  const step = useStepRunner(
    (s: Step, input, token) => runWarehouseStepAction(entity, s, recordId, input, token),
    (outcome: { ok: true } & WarehouseOutcome) => {
      if ("id" in outcome && outcome.id) {
        open({ title: t("pack_tab"), href: `/r/warehouse.pack/${outcome.id}`, kind: "record" });
        router.push(`/r/warehouse.pack/${outcome.id}`);
      } else router.refresh();
    },
  );
  const may = (process: string) => view.steps.includes(process);
  const editable = may("warehouse.pick.update") || may("warehouse.pick.confirm");

  const draftsOf = () => Object.fromEntries(view.pickLines.map((l) => [l.id, { sourceKey: l.sourceKey, qty: l.qtyPicked === null ? "" : String(l.qtyPicked) }])) as Record<string, Draft>;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(draftsOf);
  const linesKey = view.pickLines.map((l) => `${l.id}:${l.sourceKey}:${l.qtyPicked ?? ""}`).join("|");
  const [seen, setSeen] = useState(linesKey);
  if (seen !== linesKey) {
    setSeen(linesKey);
    setDrafts(draftsOf());
  }
  const touched = (l: PickLineView) => {
    const d = drafts[l.id];
    return !!d && (d.sourceKey !== l.sourceKey || d.qty !== (l.qtyPicked === null ? "" : String(l.qtyPicked)));
  };
  const badQty = view.pickLines.some((l) => Number.isNaN(parse(drafts[l.id]?.qty ?? "")));
  /** The lines the picker changed (only those: a line left alone is taken as proposed on «Confirmar»). */
  const changedLines = () =>
    view.pickLines.filter(touched).map((l) => {
      const d = drafts[l.id]!;
      const source = l.sources.find((s) => s.key === d.sourceKey);
      const qty = parse(d.qty);
      return {
        pickLineId: l.id,
        locationId: source ? source.locationId : null,
        lotId: source ? source.lotId : null,
        serialId: source ? source.serialId : null,
        qtyPicked: qty ?? (source ? l.qtyRequested : 0),
      };
    });

  const [packages, setPackages] = useState(() => view.packages.map((p) => ({ ...p, weight: p.weightKg === null ? "" : String(p.weightKg), dims: p.dimensions ?? "" })));
  const packEditable = may("warehouse.pack.update");
  const badWeight = packages.some((p) => Number.isNaN(parse(p.weight)));

  const failureText = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;
  const stageId = view.kind === "pick" ? "pick-stage" : "pack-stage";

  return (
    <div className="erp-form">
      <Section title={t("facts")} extra={view.stage ? <span data-testid={stageId}><Pill tone={STAGE_TONE[view.stage] ?? "gray"}>{view.stageLabel ?? view.stage}</Pill></span> : undefined}>
        <div className="erp-form2">
          {view.facts.map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": f.testId } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.link ? <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} mono={f.mono} /> : <span className={f.mono ? "erp-mono" : undefined}>{f.value}</span>}
            </div>
          ))}
        </div>
      </Section>

      {view.kind === "pick" && (
        <Section title={t("pick_lines")}>
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("pick_lines")}>
              <thead>
                <tr>
                  <th scope="col" className="erp-lines__no">
                    #
                  </th>
                  <th scope="col">{t("product")}</th>
                  <th scope="col">{t("taken_from")}</th>
                  <th scope="col" className="erp-num">
                    {t("qty_requested")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("qty_picked")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("short_qty")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.pickLines.map((l) => (
                  <tr key={l.id}>
                    <td className="erp-lines__no erp-muted">{l.lineNo}</td>
                    <td>{l.product}</td>
                    <td>
                      {editable ? (
                        <select aria-label={t("taken_from_line", { n: l.lineNo })} value={drafts[l.id]?.sourceKey ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: { ...d[l.id]!, sourceKey: e.target.value } }))}>
                          <option value="">{t("no_source")}</option>
                          {l.sources.map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{l.source || "—"}</span>
                      )}
                    </td>
                    <td className="erp-num erp-mono">{qtyText(l.qtyRequested)}</td>
                    <td className="erp-num">
                      {editable ? (
                        <input
                          aria-label={t("qty_picked_line", { n: l.lineNo })}
                          className="erp-num erp-mono"
                          inputMode="decimal"
                          placeholder={qtyText(l.sourceKey ? l.qtyRequested : 0)}
                          value={drafts[l.id]?.qty ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: { ...d[l.id]!, qty: e.target.value } }))}
                        />
                      ) : (
                        <span className="erp-mono">{qtyText(l.qtyPicked)}</span>
                      )}
                    </td>
                    <td className="erp-num erp-mono" data-testid={`pick-short-${l.lineNo}`}>
                      {l.shortQty ? qtyText(l.shortQty) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && <p className="erp-small erp-muted">{t("pick_hint")}</p>}
        </Section>
      )}

      {view.kind === "pack" && (
        <Section title={t("packages")}>
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("packages")}>
              <thead>
                <tr>
                  <th scope="col" className="erp-lines__no">
                    #
                  </th>
                  <th scope="col">{t("contents")}</th>
                  <th scope="col" className="erp-num">
                    {t("weight_kg")}
                  </th>
                  <th scope="col">{t("dimensions")}</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p, i) => (
                  <tr key={p.id}>
                    <td className="erp-lines__no erp-muted">{p.packageNo}</td>
                    <td>{p.contents || "—"}</td>
                    <td className="erp-num">
                      {packEditable ? (
                        <input aria-label={t("weight_line", { n: p.packageNo })} className="erp-num erp-mono" inputMode="decimal" value={p.weight} onChange={(e) => setPackages((all) => all.map((x, k) => (k === i ? { ...x, weight: e.target.value } : x)))} />
                      ) : (
                        <span className="erp-mono">{qtyText(p.weightKg)}</span>
                      )}
                    </td>
                    <td>
                      {packEditable ? (
                        <input aria-label={t("dimensions_line", { n: p.packageNo })} maxLength={100} value={p.dims} onChange={(e) => setPackages((all) => all.map((x, k) => (k === i ? { ...x, dims: e.target.value } : x)))} />
                      ) : (
                        <span>{p.dimensions || "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
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
            {may("warehouse.pick.start") && (
              <button type="button" className="erp-btn" disabled={step.busy} onClick={() => step.run("start", {})}>
                {t("start")}
              </button>
            )}
            {may("warehouse.pick.update") && (
              <button type="button" className="erp-btn" disabled={step.busy || badQty || !view.pickLines.some(touched)} onClick={() => step.run("update", { lines: changedLines() })}>
                {t("save_lines")}
              </button>
            )}
            {may("warehouse.pick.confirm") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy || badQty} onClick={() => step.run("confirm", { lines: changedLines() })}>
                {t("confirm_pick")}
              </button>
            )}
            {may("warehouse.pack.create") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("pack", {})}>
                {t("create_pack")}
              </button>
            )}
            {packEditable && (
              <button
                type="button"
                className="erp-btn"
                disabled={step.busy || badWeight}
                onClick={() =>
                  step.run("update", {
                    packages: packages.map((p) => ({ packageNo: p.packageNo, ...(parse(p.weight) !== null ? { weightKg: parse(p.weight) } : {}), ...(p.dims.trim() ? { dimensions: p.dims.trim() } : {}), lines: p.items })),
                  })
                }
              >
                {t("save_packages")}
              </button>
            )}
            {may("warehouse.pack.close") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("close", {})}>
                {t("close_pack")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

