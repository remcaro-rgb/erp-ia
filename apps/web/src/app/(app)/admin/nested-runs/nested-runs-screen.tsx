"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NestedPair, NestedProcessOption, NestedRunsData } from "@/lib/admin/load";
import { nestedAction } from "@/lib/nested/actions";
import { processName } from "@/lib/nested/names";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

type OnFailure = NestedPair["onFailure"];

/**
 * Ejecuciones anidadas (plan 2B Task 32, owner decisions item 1): the depth, and per pair (parent process → nested process) whether the parent's
 * fresh code covers a step-up nested process and whether a nested failure rolls everything back (the default) or continues and queues. Pairs are
 * chosen from the registry, never typed (R32-13). Every change is a step-up process (rule 15) that asks for the code in the dock.
 */
export function NestedRunsScreen({ data }: { data: NestedRunsData }) {
  const t = useTranslations();
  const { execute, prompt, status, busy } = useAdminAction();
  const byId = new Map(data.processes.map((p) => [p.id, p]));
  const label = (id: string) => (t.has(`process.${id}`) ? t(`process.${id}`) : processName(id, byId.get(id)?.description));
  const savePair = (parent: string, nested: string, totpCovers: boolean, onFailure: OnFailure) =>
    execute((token) => nestedAction("pair", { parent, nested, totpCovers, onFailure }, token));
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.nested_runs.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.nested_runs.hint")}</span>
        <span className="erp-grow" />
        <Link href="/nested-failures" className="erp-btn erp-btn--sm">
          {t("common.admin.nested_runs.queue_link", { count: data.pending })}
        </Link>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      <DepthRow data={data} busy={busy} onSave={(maxDepth) => execute((token) => nestedAction("depth", { maxDepth }, token))} />
      <AddPair data={data} busy={busy} label={label} onSave={savePair} />
      <div className="erp-admin__scroll">
        <table aria-label={t("common.admin.nested_runs.pairs_title")}>
          <thead>
            <tr>
              <th>{t("common.admin.nested_runs.col_parent")}</th>
              <th>{t("common.admin.nested_runs.col_nested")}</th>
              <th>{t("common.admin.nested_runs.covers")}</th>
              <th>{t("common.admin.nested_runs.failure.label")}</th>
            </tr>
          </thead>
          <tbody>
            {data.pairs.length === 0 && (
              <tr>
                <td colSpan={4} className="erp-muted" style={{ whiteSpace: "normal" }}>
                  {t("common.admin.nested_runs.empty")}
                </td>
              </tr>
            )}
            {data.pairs.map((pair) => {
              const nested = byId.get(pair.nested);
              const parent = byId.get(pair.parent);
              return (
                <tr key={pair.id}>
                  <td>
                    <ProcessName id={pair.parent} label={label(pair.parent)} />
                  </td>
                  <td>
                    <ProcessName id={pair.nested} label={label(pair.nested)} />
                    {!nested && <div className="erp-small erp-muted">{t("common.admin.nested_runs.not_registered")}</div>}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={pair.totpCovers}
                      aria-label={`${t("common.admin.nested_runs.covers")} · ${pair.nested}`}
                      disabled={busy}
                      className={`erp-toggle${pair.totpCovers ? " is-on" : ""}`}
                      onClick={() => void savePair(pair.parent, pair.nested, !pair.totpCovers, pair.onFailure)}
                    />
                    {pair.totpCovers && parent && !parent.stepUp && <div className="erp-small erp-muted">{t("common.admin.nested_runs.covers_idle", { parent: pair.parent })}</div>}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>
                    <FailureSelect
                      value={pair.onFailure}
                      locked={nested?.ledgerOrStock === true}
                      disabled={busy}
                      name={pair.nested}
                      onChange={(onFailure) => void savePair(pair.parent, pair.nested, pair.totpCovers, onFailure)}
                    />
                    {nested?.ledgerOrStock && <LedgerBadge />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <StepUpDock prompt={prompt} />
    </section>
  );
}

function ProcessName({ id, label }: { id: string; label: string }) {
  return (
    <>
      <div>{label}</div>
      <div className="erp-mono erp-small erp-muted">{id}</div>
    </>
  );
}

/** The badge of a nested process that posts to the ledger or moves stock: its failure always rolls everything back (R32-5). */
function LedgerBadge() {
  const t = useTranslations();
  return (
    <div>
      <span className="erp-pill erp-pill--warn">{t("common.admin.nested_runs.ledger.badge")}</span>
      <div className="erp-small erp-muted">{t("common.admin.nested_runs.ledger.hint")}</div>
    </div>
  );
}

function FailureSelect({ value, locked, disabled, name, onChange, id }: { value: OnFailure; locked: boolean; disabled: boolean; name: string; onChange: (value: OnFailure) => void; id?: string }) {
  const t = useTranslations();
  return (
    <select id={id} aria-label={`${t("common.admin.nested_runs.failure.label")} · ${name}`} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as OnFailure)}>
      <option value="rollback">{t("common.admin.nested_runs.failure.rollback")}</option>
      <option value="continue" disabled={locked}>
        {t("common.admin.nested_runs.failure.continue")}
      </option>
    </select>
  );
}

function DepthRow({ data, busy, onSave }: { data: NestedRunsData; busy: boolean; onSave: (maxDepth: number) => Promise<unknown> }) {
  const t = useTranslations();
  const [value, setValue] = useState(String(data.maxDepth));
  const [shown, setShown] = useState(data.maxDepth);
  if (shown !== data.maxDepth) {
    setShown(data.maxDepth);
    setValue(String(data.maxDepth));
  }
  const depth = Number(value);
  const valid = Number.isInteger(depth) && depth >= 1 && depth <= data.hardMax;
  return (
    <div className="erp-admin__row">
      <div className="erp-grow">
        <label htmlFor="nested-depth">
          <b>{t("common.admin.nested_runs.depth.label")}</b>
        </label>
        <div className="erp-small erp-muted">{t("common.admin.nested_runs.depth.hint", { max: data.hardMax, default: data.defaultDepth })}</div>
      </div>
      <input id="nested-depth" type="number" inputMode="numeric" min={1} max={data.hardMax} step={1} style={{ width: 72 }} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className="erp-btn" disabled={busy || !valid || depth === data.maxDepth} onClick={() => void onSave(depth)}>
        {t("common.admin.nested_runs.depth.save")}
      </button>
    </div>
  );
}

/** Choosing the pair from the registry: a nested process that only runs inside declared parents offers only those parents. */
function AddPair({
  data,
  busy,
  label,
  onSave,
}: {
  data: NestedRunsData;
  busy: boolean;
  label: (id: string) => string;
  onSave: (parent: string, nested: string, totpCovers: boolean, onFailure: OnFailure) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations();
  const [parent, setParent] = useState("");
  const [nestedId, setNestedId] = useState("");
  const [covers, setCovers] = useState(false);
  const [onFailure, setOnFailure] = useState<OnFailure>("rollback");
  const nested: NestedProcessOption | undefined = data.processes.find((p) => p.id === nestedId);
  const parents = data.processes.filter((p) => p.id !== nestedId && (!nested?.onlyFrom || nested.onlyFrom.includes(p.id)));
  const choose = (id: string) => {
    const next = data.processes.find((p) => p.id === id);
    setNestedId(id);
    if (next?.onlyFrom && !next.onlyFrom.includes(parent)) setParent(next.onlyFrom.length === 1 ? next.onlyFrom[0]! : "");
    if (next?.ledgerOrStock) setOnFailure("rollback");
  };
  const ready = parent !== "" && nestedId !== "";
  return (
    <form
      className="erp-admin__row"
      style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}
      aria-label={t("common.admin.nested_runs.add.title")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        if ((await onSave(parent, nestedId, covers, onFailure)).ok) {
          setParent("");
          setNestedId("");
          setCovers(false);
          setOnFailure("rollback");
        }
      }}
    >
      <div className="erp-field">
        <label htmlFor="nested-add-nested">{t("common.admin.nested_runs.add.nested")}</label>
        <select id="nested-add-nested" value={nestedId} onChange={(e) => choose(e.target.value)}>
          <option value="">{t("common.admin.nested_runs.add.choose")}</option>
          {data.processes.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p.id)} · {p.id}
            </option>
          ))}
        </select>
      </div>
      <div className="erp-field">
        <label htmlFor="nested-add-parent">{t("common.admin.nested_runs.add.parent")}</label>
        <select id="nested-add-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">{t("common.admin.nested_runs.add.choose")}</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p.id)} · {p.id}
            </option>
          ))}
        </select>
      </div>
      <label className="erp-check">
        <input type="checkbox" checked={covers} onChange={(e) => setCovers(e.target.checked)} /> {t("common.admin.nested_runs.add.covers")}
      </label>
      <div className="erp-field">
        <label htmlFor="nested-add-failure">{t("common.admin.nested_runs.add.failure")}</label>
        <FailureSelect id="nested-add-failure" value={onFailure} locked={nested?.ledgerOrStock === true} disabled={false} name={nestedId} onChange={setOnFailure} />
      </div>
      <button type="submit" className="erp-btn erp-btn--primary" disabled={busy || !ready}>
        {t("common.admin.nested_runs.add.submit")}
      </button>
      {nested?.onlyFrom && <div className="erp-small erp-muted" style={{ flexBasis: "100%" }}>{t("common.admin.nested_runs.add.only_from", { list: nested.onlyFrom.join(", ") })}</div>}
      {nested?.ledgerOrStock && (
        <div style={{ flexBasis: "100%" }}>
          <LedgerBadge />
        </div>
      )}
    </form>
  );
}
