"use client";

import { DEFAULT_FIELD_LABELS, type FieldLabels, type VerifyKind, type VerifyStatus } from "./field-model";

export interface VerifyBadgeProps {
  kind: VerifyKind;
  /** What the provider would verify; the button is disabled while it is empty. */
  value: string;
  /** State of the latest request for this value, when there is one. */
  status?: VerifyStatus;
  /** Provider that answered, when verified. */
  provider?: string | null;
  onVerify: () => void;
  labels?: Partial<FieldLabels>;
}

const TONE: Record<VerifyStatus, string> = { queued: "gray", verified: "ok", failed: "danger" };

/**
 * The Verificar control of an e-mail, phone or identification (design §5.16): the state of the last request
 * ("en cola" while no provider is configured) and the button that asks `kernel.verify.request`.
 */
export function VerifyBadge({ kind, value, status, provider, onVerify, labels: overrides }: VerifyBadgeProps) {
  const labels: FieldLabels = { ...DEFAULT_FIELD_LABELS, ...overrides };
  const text = status === "queued" ? labels.queued : status === "verified" ? labels.verified(provider) : status === "failed" ? labels.failed : null;
  return (
    <span className="erp-verify" data-kind={kind}>
      {status && text && <span className={`erp-pill erp-pill--${TONE[status]}`}>{text}</span>}
      <button type="button" title={labels.verifyTitle} disabled={value.trim() === ""} onClick={onVerify}>
        {labels.verify}
      </button>
    </span>
  );
}
