"use client";

import { useId } from "react";
import { VerifyBadge } from "./VerifyBadge";
import { DEFAULT_FIELD_LABELS, emailProblem, type FieldLabels, type FieldVerify } from "./field-model";

export interface EmailFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** An empty value is flagged "Requerido". */
  required?: boolean;
  disabled?: boolean;
  /** Text shown next to the label. */
  hint?: string;
  /** Shows the Verificar control once the e-mail is valid. */
  verify?: FieldVerify;
  labels?: Partial<FieldLabels>;
  className?: string;
}

/** E-mail input validated inline (rule 11: `nombre@dominio.ext`, at most 100 characters). */
export function EmailField({ label, value, onChange, required, disabled, hint, verify, labels: overrides, className }: EmailFieldProps) {
  const labels: FieldLabels = { ...DEFAULT_FIELD_LABELS, ...overrides };
  const id = useId();
  const problem = emailProblem(value);
  const missing = required && value === "";
  return (
    <div className={["erp-field", "erp-field--email", className].filter(Boolean).join(" ")}>
      <label htmlFor={`${id}-email`}>
        {label}
        {hint && <span className="erp-field__hint"> {hint}</span>}
      </label>
      <input
        id={`${id}-email`}
        type="email"
        maxLength={100}
        aria-invalid={problem !== null || !!missing}
        aria-describedby={`${id}-note`}
        className={problem ? "erp-input--bad" : undefined}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.trim())}
      />
      <div id={`${id}-note`}>
        {problem || missing ? (
          <span role="alert" className="erp-field__error">
            {problem ?? labels.required}
          </span>
        ) : value ? (
          <span className="erp-field__ok">
            {labels.validFormat}
            {verify && (
              <>
                {" "}
                <VerifyBadge kind="email" value={value} status={verify.status} provider={verify.provider} disabled={verify.disabled} labels={overrides} onVerify={() => verify.onVerify(value)} />
              </>
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
