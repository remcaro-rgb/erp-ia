"use client";

import { useTranslations } from "next-intl";
import { EntityLookup, foundRowMissing, gridFetcher, recordHref, type CodeOption, type FoundRow, type GridRow, type LookupSource } from "@erp/ui";

/**
 * The found rows of an open conteo (Task 28.5): product, ubicación, for a lot product one of its lots or a new code with its expiry, for a
 * serial product the number (a scanner types it and ends with Enter, which opens the next row of the same product), and the counted quantity
 * (1, fixed, for a serial). A row's refusals from the process show under it.
 */
export function FoundRows({
  rows, product, locations, tracking, lots, errors, busy, onChange, onAdd, onRemove,
}: {
  rows: readonly FoundRow[];
  product?: LookupSource;
  locations: readonly CodeOption[];
  tracking: Readonly<Record<string, "lot" | "serial">>;
  lots: Readonly<Record<string, CodeOption[]>>;
  errors: Readonly<Record<number, string[]>>;
  busy: boolean;
  onChange: (key: string, patch: Partial<FoundRow>) => void;
  onAdd: (from?: FoundRow) => void;
  onRemove: (key: string) => void;
}) {
  const t = useTranslations("inventory.count.found");
  const tv = useTranslations("inventory.view");
  const fetcher = gridFetcher("core.product");
  const NEW_LOT = "__new";
  if (rows.length === 0) return null;
  return (
    <div className="erp-sec" data-testid="count-found">
      <h4>{t("title")}</h4>
      <div className="erp-lines__scroll">
        <table className="erp-lines__table" aria-label={t("title")}>
          <thead>
            <tr>
              <th scope="col" className="erp-lines__no">#</th>
              <th scope="col">{tv("product")}</th>
              <th scope="col">{tv("location")}</th>
              <th scope="col">{tv("lot_serial")}</th>
              <th scope="col" className="erp-num">{tv("counted_qty")}</th>
              <th scope="col"><span className="sr-only">{t("remove_column")}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const n = i + 1;
              const productLots = lots[r.productId] ?? [];
              const missing = r.productId ? foundRowMissing(r).filter((m) => m !== "product") : [];
              const rowErrors = [...(errors[i] ?? []), ...missing.map((m) => t(`missing.${m}`))];
              return [
                <tr key={r.key}>
                  <td className="erp-lines__no erp-muted">{n}</td>
                  <td style={{ minWidth: 260 }}>
                    <EntityLookup
                      aria-label={t("product", { n })}
                      entityLabel={product?.entityLabel ?? ""}
                      fetcher={fetcher}
                      fields={product?.fields ?? []}
                      baseFilters={[{ field: "kind", op: "eq", value: "good" }, { field: "track_stock", op: "eq", value: true }]}
                      disabled={busy}
                      value={r.productId ? { id: r.productId, label: r.productLabel } : null}
                      href={product?.linkable && r.productId ? recordHref("core.product", r.productId) : null}
                      describe={(row: GridRow) => ({ label: `${String(row.sku ?? "")} · ${String(row.description ?? "")}`, sub: String(row.uom_code ?? "") })}
                      onPick={(row) => onChange(r.key, {
                        productId: row?.id ?? "", productLabel: row ? `${String(row.sku ?? "")} · ${String(row.description ?? "")}` : "",
                        tracking: (row && tracking[row.id]) || "none", lotId: "", lotCode: "", expiresOn: "", serialNo: "", countedQty: row && tracking[row.id] === "serial" ? "1" : r.countedQty,
                      })}
                    />
                  </td>
                  <td>
                    <select aria-label={t("location", { n })} value={r.locationId} disabled={busy || locations.length === 0} onChange={(e) => onChange(r.key, { locationId: e.target.value })}>
                      <option value="">{t("no_location")}</option>
                      {locations.map((o) => (
                        <option key={o.code} value={o.code}>{o.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {r.tracking === "lot" && (
                      <span className="erp-row">
                        <select aria-label={t("lot", { n })} value={r.lotId || NEW_LOT} disabled={busy} onChange={(e) => onChange(r.key, e.target.value === NEW_LOT ? { lotId: "" } : { lotId: e.target.value, lotCode: "", expiresOn: "" })}>
                          <option value={NEW_LOT}>{t("new_lot")}</option>
                          {productLots.map((o) => (
                            <option key={o.code} value={o.code}>{o.name}</option>
                          ))}
                        </select>
                        {r.lotId === "" && (
                          <>
                            <input aria-label={t("lot_code", { n })} placeholder={t("lot_code_placeholder")} className="erp-mono" maxLength={60} value={r.lotCode} disabled={busy} onChange={(e) => onChange(r.key, { lotCode: e.target.value })} />
                            <input aria-label={t("expires", { n })} title={t("expires_hint")} type="date" value={r.expiresOn} disabled={busy} onChange={(e) => onChange(r.key, { expiresOn: e.target.value })} />
                          </>
                        )}
                      </span>
                    )}
                    {r.tracking === "serial" && (
                      <input
                        aria-label={t("serial", { n })}
                        placeholder={t("serial_placeholder")}
                        className="erp-mono"
                        maxLength={80}
                        value={r.serialNo}
                        disabled={busy}
                        // The new row a scan opens takes the focus, so the next scan lands in it.
                        autoFocus={i === rows.length - 1 && i > 0 && r.serialNo === ""}
                        onChange={(e) => onChange(r.key, { serialNo: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          if (r.serialNo.trim() !== "" && i === rows.length - 1) onAdd(r);
                        }}
                      />
                    )}
                    {r.tracking === "none" && <span className="erp-muted">—</span>}
                  </td>
                  <td className="erp-num">
                    <input aria-label={t("qty", { n })} className="erp-num erp-mono" inputMode="decimal" value={r.tracking === "serial" ? "1" : r.countedQty} disabled={busy || r.tracking === "serial"} onChange={(e) => onChange(r.key, { countedQty: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("remove", { n })} disabled={busy} onClick={() => onRemove(r.key)}>
                      ×
                    </button>
                  </td>
                </tr>,
                rowErrors.length > 0 ? (
                  <tr key={`${r.key}-errors`}>
                    <td />
                    <td colSpan={5} className="erp-field__error" role="alert" data-testid={`found-error-${n}`}>
                      {rowErrors.join(" · ")}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="erp-row">
        <button type="button" className="erp-btn" disabled={busy} onClick={() => onAdd()}>
          {t("add")}
        </button>
        <span className="erp-small erp-muted">{t("hint")}</span>
      </div>
    </div>
  );
}
