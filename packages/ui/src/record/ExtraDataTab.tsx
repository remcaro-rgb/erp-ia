"use client";

import { useId } from "react";
import {
  DEFAULT_EXTRA_LABELS,
  MASK,
  boolText,
  canWrite,
  fieldProblem,
  withValue,
  type ExtraDataLabels,
  type ExtraDataValue,
  type ExtraFieldDef,
  type FreeItem,
} from "./extra-data-model";

export type { ExtraDataLabels, ExtraDataValue, ExtraFieldDef, FreeItem } from "./extra-data-model";

export interface ExtraDataTabProps {
  /** The entity's custom fields with what the caller's roles may do with each (`kernel.custom_field.list`). */
  defs: readonly ExtraFieldDef[];
  /** `extra` as the caller received it (fields they may not view are absent). */
  extra: Record<string, unknown>;
  extraFree: readonly FreeItem[];
  readOnly?: boolean;
  /** Called with the whole `extra` and `extra_free` after every edit. */
  onChange?: (value: ExtraDataValue) => void;
  labels?: Partial<ExtraDataLabels>;
  /** Appended to the root's `erp-extra` class. */
  className?: string;
}

/**
 * "Datos adicionales" of a record (design §5.14, prototype v5): the fields the administrator defined, each
 * typed, limited and gated by the caller's roles to enter, edit and view, plus the free name / value pairs
 * any user may add. The server validates again; this tab only shows the same problems early.
 */
export function ExtraDataTab({ defs, extra, extraFree, readOnly = false, onChange, labels: overrides, className }: ExtraDataTabProps) {
  const labels: ExtraDataLabels = { ...DEFAULT_EXTRA_LABELS, ...overrides, types: { ...DEFAULT_EXTRA_LABELS.types, ...overrides?.types } };
  const base = useId();
  const emit = (next: Partial<ExtraDataValue>) => onChange?.({ extra, extraFree: [...extraFree], ...next });
  const setField = (key: string, value: unknown) => emit({ extra: withValue(extra, key, value) });
  const setFree = (index: number, patch: Partial<FreeItem>) => emit({ extraFree: extraFree.map((item, i) => (i === index ? { ...item, ...patch } : item)) });

  const renderField = (def: ExtraFieldDef) => {
    const id = `${base}-${def.key}`;
    if (!def.canView) {
      return (
        <div className="erp-field" key={def.key}>
          <label htmlFor={id}>{def.label}</label>
          <input id={id} type="text" disabled value={MASK} title={labels.hiddenTitle} readOnly />
        </div>
      );
    }
    const value = extra[def.key];
    const text = value === undefined || value === null ? "" : String(value);
    const writable = canWrite(def, value, readOnly);
    const problem = fieldProblem(def, value);
    const common = { id, disabled: !writable, "aria-invalid": problem !== null } as const;
    let input;
    if (def.type === "list") {
      input = (
        <select {...common} value={text} onChange={(event) => setField(def.key, event.target.value)}>
          <option value="">{labels.none}</option>
          {(def.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    } else if (def.type === "bool") {
      input = (
        <select {...common} value={boolText(value, labels)} onChange={(event) => setField(def.key, event.target.value === "" ? "" : event.target.value === labels.yes)}>
          <option value="">{labels.none}</option>
          <option value={labels.yes}>{labels.yes}</option>
          <option value={labels.no}>{labels.no}</option>
        </select>
      );
    } else {
      input = (
        <input
          {...common}
          type={def.type === "date" ? "date" : "text"}
          inputMode={def.type === "number" ? "decimal" : undefined}
          maxLength={def.maxLength ?? undefined}
          className={problem ? "erp-input--bad" : def.type === "number" ? "erp-input--number" : undefined}
          value={text}
          onChange={(event) => setField(def.key, event.target.value)}
        />
      );
    }
    return (
      <div className="erp-field" key={def.key}>
        <label htmlFor={id}>
          {def.label}
          {def.required && <span className="erp-pill erp-pill--warn"> {labels.required}</span>}{" "}
          <span className="erp-field__hint">
            {labels.types[def.type]}
            {def.maxLength ? ` · ${labels.maxLength(def.maxLength)}` : ""}
            {!readOnly && !writable ? ` · ${labels.readOnlyForRole}` : ""}
          </span>
        </label>
        {input}
        {problem && (
          <span role="alert" className="erp-field__error">
            {problem}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={["erp-extra", className].filter(Boolean).join(" ")}>
      <section className="erp-extra__defined">
        <h3>
          {labels.definedTitle} <span className="erp-field__hint">{labels.definedHint}</span>
        </h3>
        {defs.length > 0 ? <div className="erp-extra__fields">{defs.map(renderField)}</div> : <p className="erp-extra__muted">{labels.noDefs}</p>}
      </section>
      <section className="erp-extra__free">
        <h3>
          {labels.freeTitle} <span className="erp-field__hint">{labels.freeHint}</span>
        </h3>
        {extraFree.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>{labels.name}</th>
                <th>{labels.value}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {extraFree.map((item, index) => (
                <tr key={index}>
                  <td>
                    <input type="text" aria-label={labels.name} maxLength={200} disabled={readOnly} value={item.name} onChange={(event) => setFree(index, { name: event.target.value })} />
                  </td>
                  <td>
                    <input type="text" aria-label={labels.value} maxLength={200} disabled={readOnly} value={item.value} onChange={(event) => setFree(index, { value: event.target.value })} />
                  </td>
                  <td>
                    {!readOnly && (
                      <button type="button" aria-label={labels.remove} onClick={() => emit({ extraFree: extraFree.filter((_, i) => i !== index) })}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="erp-extra__muted">{labels.noFree}</p>
        )}
        {!readOnly && (
          <button type="button" onClick={() => emit({ extraFree: [...extraFree, { name: "", value: "" }] })}>
            {labels.add}
          </button>
        )}
      </section>
    </div>
  );
}
