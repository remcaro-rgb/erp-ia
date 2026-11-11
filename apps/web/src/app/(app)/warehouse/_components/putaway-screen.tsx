"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { useStepRunner, type StepFailure } from "@/lib/records/use-step-runner";
import { confirmPutawayAction, suggestPutawayAction } from "@/lib/warehouse/actions";
import type { PutawayPageData, SuggestionLineView } from "@/lib/warehouse/screens";
import { Failure, useFailureText } from "./failure";

// Documentos › Ubicar recibidos (plan 2B.2 Task 29.4, PG §4.3 step 8, owner item 239): a receipt, where each line should go
// (warehouse.putaway.suggest), the destination editable, «Confirmar ubicación» (warehouse.putaway.confirm).

// -------------------------------------------------------------------------------------------------
// Ubicar recibidos
// -------------------------------------------------------------------------------------------------

type Suggested = { listed: boolean; reason?: string; lines: SuggestionLineView[] };
const qtyText = (n: number) => new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 }).format(n);

export function PutawayScreen({ data }: { data: PutawayPageData }) {
  const t = useTranslations("warehouse.putaway_page");
  const failureText = useFailureText();
  const id = useId();
  const [movementId, setMovementId] = useState(data.selected ?? "");
  const [suggested, setSuggested] = useState<Suggested | null>(data.initial);
  const [targets, setTargets] = useState<string[]>(() => (data.initial?.lines ?? []).map((l) => l.toLocationId ?? ""));
  const [loading, setLoading] = useState(false);
  const [loadFailure, setLoadFailure] = useState<StepFailure | null>(null);
  const [done, setDone] = useState(false);
  const receipt = data.receipts.find((r) => r.id === movementId);
  const locations = receipt ? data.locations.filter((l) => l.warehouseId === receipt.warehouseId) : [];

  const load = async (mid: string) => {
    setSuggested(null);
    setLoadFailure(null);
    if (!mid) return;
    setLoading(true);
    try {
      const out = await suggestPutawayAction(mid);
      if (out.ok) {
        setSuggested(out);
        setTargets(out.lines.map((l) => l.toLocationId ?? ""));
      } else setLoadFailure(out);
    } finally {
      setLoading(false);
    }
  };

  const step = useStepRunner(
    (_s: "confirm", input, token) => confirmPutawayAction(movementId, input.lines, token),
    () => {
      setDone(true);
      setSuggested(null);
    },
  );
  const rows = suggested?.lines ?? [];
  const chosen = rows.flatMap((l, i) => (targets[i] && targets[i] !== l.fromLocationId ? [{ ...l, toLocationId: targets[i]! }] : []));

  return (
    <div className="erp-form">
      <section className="erp-sec">
        <h3>{t("title")}</h3>
        <p className="erp-small erp-muted">{t("hint")}</p>
        <div className="erp-field erp-span3">
          <label htmlFor={id}>{t("receipt")}</label>
          <select
            id={id}
            value={movementId}
            disabled={loading || step.busy}
            onChange={(e) => {
              setMovementId(e.target.value);
              setDone(false);
              void load(e.target.value);
            }}
          >
            <option value="">{t("pick_receipt")}</option>
            {data.receipts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {loading && (
          <p className="erp-small erp-muted" role="status">
            {t("loading")}
          </p>
        )}
      </section>

      {suggested && !suggested.listed && <p className="erp-dian">{t("before_enabled")}</p>}
      {suggested && suggested.listed && rows.length === 0 && (
        <p className="erp-dian erp-dian--ok" data-testid="putaway-nothing">
          {t("nothing")}
        </p>
      )}
      {rows.length > 0 && (
        <section className="erp-sec">
          <h3>{t("lines")}</h3>
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("lines")}>
              <thead>
                <tr>
                  <th scope="col">{t("product")}</th>
                  <th scope="col">{t("lot_serial")}</th>
                  <th scope="col" className="erp-num">
                    {t("qty")}
                  </th>
                  <th scope="col">{t("from")}</th>
                  <th scope="col">{t("to")}</th>
                  <th scope="col">{t("basis")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l, i) => (
                  <tr key={`${l.productId}-${l.lotId ?? ""}-${l.serialId ?? ""}-${i}`}>
                    <td>{l.product}</td>
                    <td className="erp-mono">{l.serial ?? l.lot ?? "—"}</td>
                    <td className="erp-num erp-mono">{qtyText(l.qty)}</td>
                    <td>{l.from ?? t("no_location")}</td>
                    <td>
                      <select aria-label={t("to_line", { n: i + 1 })} value={targets[i] ?? ""} disabled={!data.mayConfirm || step.busy} onChange={(e) => setTargets((all) => all.map((x, k) => (k === i ? e.target.value : x)))}>
                        <option value="">{t("leave")}</option>
                        {locations
                          .filter((loc) => loc.id !== l.fromLocationId)
                          .map((loc) => (
                            <option key={loc.id} value={loc.id}>
                              {loc.label}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="erp-small erp-muted">{t(`basis_values.${l.basis}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Failure text={failureText(loadFailure) ?? failureText(step.failure)} />
      {done && (
        <div className="erp-dian erp-dian--ok" role="status" data-testid="putaway-done">
          {t("done")}
        </div>
      )}
      {data.mayConfirm && rows.length > 0 && (
        <div className="erp-form__actions">
          {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
          <div className="erp-row">
            <span className="erp-grow" />
            <button
              type="button"
              className="erp-btn erp-btn--primary"
              disabled={step.busy || chosen.length === 0}
              onClick={() =>
                step.run("confirm", {
                  lines: chosen.map((l) => ({ productId: l.productId, lotId: l.lotId, serialId: l.serialId, qty: l.qty, fromLocationId: l.fromLocationId, toLocationId: l.toLocationId })),
                })
              }
            >
              {t("confirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

