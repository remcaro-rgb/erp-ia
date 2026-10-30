import type { ReactNode } from "react";
import { cn } from "../lib/utils";

// A read-only table in the look of the lines editor, for the tabs of the accounting records (Saldos, Resultados, Resumen, Cierre…).

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  /** A number: right-aligned, tabular figures. */
  num?: boolean;
  mono?: boolean;
  render: (row: T) => ReactNode;
  /** The column's cell in the footer row. */
  total?: ReactNode;
}

export function SimpleTable<T>({ label, columns, rows, rowKey, empty }: { label: string; columns: readonly TableColumn<T>[]; rows: readonly T[]; rowKey: (row: T) => string; empty: string }) {
  if (rows.length === 0) return <p className="erp-muted erp-small">{empty}</p>;
  const hasTotals = columns.some((c) => c.total !== undefined);
  return (
    <div className="erp-lines__scroll">
      <table className="erp-lines__table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn(c.num && "erp-num")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={cn(c.num && "erp-num", (c.num || c.mono) && "erp-mono")}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope={c.key === columns[0]!.key ? "row" : undefined} className={cn(c.num && "erp-num", c.num && "erp-mono")}>
                  {c.total ?? ""}
                </th>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** "Sin acceso": the answer of a tab whose data the caller may not view (§5.13). */
export function NoAccess({ text }: { text: string }) {
  return (
    <p role="status" className="erp-dian erp-dian--warn">
      {text}
    </p>
  );
}
