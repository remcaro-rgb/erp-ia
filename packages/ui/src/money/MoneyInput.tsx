"use client";

import { useState, type InputHTMLAttributes } from "react";
import { cn } from "@erp/ui/lib/utils";
import { formatMoney, moneyEditText, parseMoney } from "./format";

export interface MoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: number | null | undefined;
  /** The amount after an edit (on blur), or null when the field was emptied. */
  onChange: (value: number | null) => void;
  currency?: string;
}

/** An amount input (rule 23): shows `$ 1.234.567,00`, right-aligned with tabular figures; raw digits while focused. */
export function MoneyInput({ value, onChange, currency = "COP", className, onFocus, onBlur, ...rest }: MoneyInputProps) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={cn("text-right tabular-nums", className)}
      value={editing ?? formatMoney(value ?? null, currency)}
      onFocus={(event) => {
        setEditing(moneyEditText(value ?? null));
        event.currentTarget.select();
        onFocus?.(event);
      }}
      onChange={(event) => setEditing(event.target.value)}
      onBlur={(event) => {
        if (editing !== null) onChange(parseMoney(editing));
        setEditing(null);
        onBlur?.(event);
      }}
    />
  );
}
