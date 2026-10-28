// Copy, calling codes and pure rules of the phone / e-mail fields and the verification badge (design §5.16,
// rule 11). No React here, so the rules are unit-tested without a DOM. The validators are the kernel's own,
// imported from its dependency-free subpath so the browser bundle does not pull the server code.

import { validateEmail, validatePhone } from "@erp/kernel/validation";

/** Calling codes the form offers: [code without "+", label]. */
export const PHONE_CODES: readonly (readonly [string, string])[] = [
  ["57", "CO +57"],
  ["1", "US +1"],
  ["52", "MX +52"],
  ["593", "EC +593"],
  ["51", "PE +51"],
  ["507", "PA +507"],
  ["34", "ES +34"],
  ["56", "CL +56"],
];

export type VerifyKind = "email" | "phone" | "document";
export type VerifyStatus = "queued" | "verified" | "failed";

/** What a field needs to show the Verificar control: the request state and what to do on click. */
export interface FieldVerify {
  status?: VerifyStatus;
  /** Provider that answered, when verified. */
  provider?: string | null;
  /** Receives the value to verify: the e-mail, or the phone as `+<cc><number>`. */
  onVerify: (value: string) => void;
  /** The request is already in flight or queued (or done): the button waits so the same datum is not asked twice. */
  disabled?: boolean;
}

/** Copy of the fields. Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export interface FieldLabels {
  countryCode: string;
  validFormat: string;
  phoneHintCo: string;
  phoneHintOther: string;
  required: string;
  verify: string;
  verifyTitle: string;
  queued: string;
  verified: (provider?: string | null) => string;
  failed: string;
}

export const DEFAULT_FIELD_LABELS: FieldLabels = {
  countryCode: "Indicativo del país",
  validFormat: "✓ formato válido",
  phoneHintCo: "Celular 3… o fijo 60… (10 dígitos)",
  phoneHintOther: "Sin indicativo, solo dígitos",
  required: "Requerido",
  verify: "Verificar ↗",
  verifyTitle: "Verificar con el proveedor externo",
  queued: "en cola",
  verified: (provider) => (provider ? `verificado · ${provider}` : "verificado"),
  failed: "no verificado",
};

/** The inline error of a phone, or null while it is empty or valid. */
export const phoneProblem = (cc: string, number: string): string | null => (number === "" ? null : validatePhone(cc, number));

/** The inline error of an e-mail, or null while it is empty or valid. */
export const emailProblem = (value: string): string | null => (value === "" ? null : validateEmail(value));

/** `+573001234567`: the value the verification hook receives. */
export const phoneValue = (cc: string, number: string): string => `+${cc.replace(/^\+/, "")}${number}`;

/** `+57 300 1234567`-style text for lists: the code, then the number as stored; empty when there is no number. */
export const formatPhone = (cc: string | null | undefined, number: string | null | undefined): string =>
  number ? `+${(cc ?? "57").replace(/^\+/, "")} ${number}` : "";

/** Digits only: what the number input keeps. */
export const digitsOnly = (value: string): string => value.replace(/\D/g, "");
