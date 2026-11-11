"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

// Versiones of a documento (entity types spec §8, D18, approved prototype): the snapshots in order and a side-by-side compare of two
// of them. What the viewer may not see comes masked from the server (••••••••) in every version and is never marked as changed, so
// neither its value nor when it changed is revealed. Read-only: versions cannot be edited or deleted.

export interface VersionSnapshot {
  version: number;
  status: string;
  at: string;
  by: string | null;
  reason: string | null;
  header: Readonly<Record<string, string>>;
  lines: readonly Readonly<Record<string, string>>[];
}

export interface VersionsTabProps {
  snapshots: readonly VersionSnapshot[];
  /** Field labels by name. */
  labels: { header: Readonly<Record<string, string>>; lines: Readonly<Record<string, string>> };
  /** The value the server puts in place of a masked field. */
  masked?: string;
}

const MASK = "••••••••";

export function VersionsTab({ snapshots, labels, masked = MASK }: VersionsTabProps) {
  const t = useTranslations("common.record.versions");
  const ts = useTranslations("common.record.status");
  const format = useFormatter();
  // Null until the person picks: the last two versions, also after the page reloads with new ones.
  const [chosen, setChosen] = useState<number[] | null>(null);
  const picked = chosen ?? (snapshots.length >= 2 ? [snapshots[snapshots.length - 2]!.version, snapshots[snapshots.length - 1]!.version] : []);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const status = (code: string) => (ts.has(code) ? ts(code) : code);
  const when = (at: string) => format.dateTime(new Date(at), { dateStyle: "short", timeStyle: "short" });

  if (snapshots.length === 0) return <p className="erp-muted">{t("empty")}</p>;
  const toggle = (v: number) => setChosen(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v].slice(-2));
  const [a, b] = [...picked].sort((x, y) => x - y);
  const A = snapshots.find((s) => s.version === a);
  const B = snapshots.find((s) => s.version === b);

  const rows: { key: string; label: string; va: string; vb: string; changed: boolean; group?: boolean }[] = [];
  if (A && B) {
    const cell = (key: string, label: string, va: string, vb: string) => {
      const hidden = va === masked || vb === masked;
      rows.push({ key, label, va: hidden ? masked : va, vb: hidden ? masked : vb, changed: !hidden && va !== vb });
    };
    cell("status", t("status"), status(A.status), status(B.status));
    for (const [name, label] of Object.entries(labels.header)) cell(`h.${name}`, label, A.header[name] ?? "", B.header[name] ?? "");
    const n = Math.max(A.lines.length, B.lines.length);
    if (n > 0) rows.push({ key: "lines", label: t("lines"), va: "", vb: "", changed: false, group: true });
    for (let i = 0; i < n; i++) {
      for (const [name, label] of Object.entries(labels.lines)) cell(`l.${i}.${name}`, t("line_field", { n: i + 1, field: label }), A.lines[i]?.[name] ?? "", B.lines[i]?.[name] ?? "");
    }
  }
  const changed = rows.filter((r) => r.changed).length;
  const shown = onlyChanges ? rows.filter((r) => r.changed || r.group) : rows;

  return (
    <div className="erp-versions" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="erp-muted erp-small">{t("intro")}</p>
      <div className="erp-lines__scroll">
        <table className="erp-lines__table" aria-label={t("version")}>
          <thead>
            <tr>
              <th scope="col">{t("pick")}</th>
              <th scope="col">{t("version")}</th>
              <th scope="col">{t("status")}</th>
              <th scope="col">{t("at")}</th>
              <th scope="col">{t("by")}</th>
              <th scope="col">{t("reason")}</th>
            </tr>
          </thead>
          <tbody>
            {[...snapshots].reverse().map((s) => (
              <tr key={s.version}>
                <td>
                  <input type="checkbox" className="erp-touch" aria-label={`${t("pick")} v${s.version}`} checked={picked.includes(s.version)} onChange={() => toggle(s.version)} />
                </td>
                <td className="erp-mono">v{s.version}</td>
                <td>{status(s.status)}</td>
                <td>{when(s.at)}</td>
                <td>{s.by ?? "—"}</td>
                <td>{s.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {A && B ? (
        <>
          <div className="erp-row">
            <h3 style={{ margin: 0 }}>{t("compare", { a: A.version, b: B.version })}</h3>
            <span className="erp-pill erp-pill--warn">{t("changed", { count: changed })}</span>
            <span className="erp-grow" />
            <label className="erp-small">
              <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> {t("only_changes")}
            </label>
          </div>
          <div className="erp-versions__cmp" role="table" aria-label={t("compare", { a: A.version, b: B.version })}>
            <div className="erp-versions__h" role="columnheader">{t("field")}</div>
            <div className="erp-versions__h" role="columnheader">
              v{A.version} · {status(A.status)} · {when(A.at)}
            </div>
            <div className="erp-versions__h" role="columnheader">
              v{B.version} · {status(B.status)} · {when(B.at)}
            </div>
            {shown.map((r) =>
              r.group ? (
                <div key={r.key} className="erp-versions__grp">
                  {r.label}
                </div>
              ) : (
                [
                  <div key={`${r.key}.k`}>{r.label}</div>,
                  <div key={`${r.key}.a`} className={r.changed ? "erp-versions__chg" : undefined} data-changed={r.changed || undefined}>
                    {r.va}
                  </div>,
                  <div key={`${r.key}.b`} className={r.changed ? "erp-versions__chg" : undefined} data-changed={r.changed || undefined}>
                    {r.vb}
                  </div>,
                ]
              ),
            )}
          </div>
          <div className="erp-dian erp-dian--info erp-small">{t("masked_note")}</div>
        </>
      ) : (
        <p className="erp-muted">{t("pick_hint")}</p>
      )}
    </div>
  );
}
