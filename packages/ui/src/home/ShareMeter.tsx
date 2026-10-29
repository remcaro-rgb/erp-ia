export interface ShareMeterProps {
  /** The share used, 0–1 (above 1 is over the cap). */
  value: number;
  /** Accessible name. */
  label: string;
  /** Share where the warning starts (a tick is drawn there). */
  warnAt?: number;
}

/**
 * A share of an allowance (the AI tokens of the month): a 12 px track with ticks at the warning share (80 %) and at the cap
 * (100 %), danger past it. Colour is never the only cue: the caller writes the percentage and, over the cap, what it means.
 */
export function ShareMeter({ value, label, warnAt = 0.8 }: ShareMeterProps) {
  const share = Number.isFinite(value) ? Math.max(0, value) : 0;
  const filled = Math.min(1, share);
  const state = share >= 1 ? " is-over" : share >= warnAt ? " is-warn" : "";
  return (
    <div className={`erp-meter${state}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(filled * 100)}>
      <i className="erp-meter__fill" style={{ width: `${filled * 100}%` }} />
      <b className="erp-meter__tick" style={{ left: `${warnAt * 100}%` }} aria-hidden="true" />
      <b className="erp-meter__tick" style={{ left: "100%" }} aria-hidden="true" />
    </div>
  );
}
