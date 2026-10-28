"use client";

import { useId } from "react";
import { VerifyBadge } from "./VerifyBadge";
import { DEFAULT_FIELD_LABELS, PHONE_CODES, digitsOnly, phoneProblem, phoneValue, type FieldLabels, type FieldVerify } from "./field-model";

export interface PhoneFieldProps {
  label: string;
  /** Calling code without "+" (`57`). */
  cc: string;
  /** National number, digits only. */
  number: string;
  onChange: (value: { cc: string; number: string }) => void;
  disabled?: boolean;
  /** Text shown next to the label, e.g. "indicativo + número". */
  hint?: string;
  /** Shows the Verificar control once the number is valid. */
  verify?: FieldVerify;
  labels?: Partial<FieldLabels>;
  className?: string;
}

/** Country-code select plus number, validated inline (rule 11): +57 takes 10 digits starting with 3 or 60, or 7; other codes 6 to 14. */
export function PhoneField({ label, cc, number, onChange, disabled, hint, verify, labels: overrides, className }: PhoneFieldProps) {
  const labels: FieldLabels = { ...DEFAULT_FIELD_LABELS, ...overrides };
  const id = useId();
  const problem = phoneProblem(cc, number);
  return (
    <div className={["erp-field", "erp-field--phone", className].filter(Boolean).join(" ")}>
      <label htmlFor={`${id}-number`}>
        {label}
        {hint && <span className="erp-field__hint"> {hint}</span>}
      </label>
      <div className="erp-phone">
        <select aria-label={labels.countryCode} value={cc} disabled={disabled} onChange={(event) => onChange({ cc: event.target.value, number })}>
          {!PHONE_CODES.some(([code]) => code === cc) && <option value={cc}>+{cc}</option>}
          {PHONE_CODES.map(([code, text]) => (
            <option key={code} value={code}>
              {text}
            </option>
          ))}
        </select>
        <input
          id={`${id}-number`}
          type="text"
          inputMode="numeric"
          maxLength={14}
          aria-invalid={problem !== null}
          aria-describedby={`${id}-note`}
          className={problem ? "erp-input--bad" : undefined}
          value={number}
          disabled={disabled}
          onChange={(event) => onChange({ cc, number: digitsOnly(event.target.value) })}
        />
      </div>
      <div id={`${id}-note`}>
        {problem ? (
          <span role="alert" className="erp-field__error">
            {problem}
          </span>
        ) : number ? (
          <span className="erp-field__ok">
            {labels.validFormat}
            {verify && (
              <>
                {" "}
                <VerifyBadge kind="phone" value={phoneValue(cc, number)} status={verify.status} provider={verify.provider} disabled={verify.disabled} labels={overrides} onVerify={() => verify.onVerify(phoneValue(cc, number))} />
              </>
            )}
          </span>
        ) : (
          <span className="erp-field__hint">{cc === "57" ? labels.phoneHintCo : labels.phoneHintOther}</span>
        )}
      </div>
    </div>
  );
}
