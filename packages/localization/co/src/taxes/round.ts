/**
 * Ties: the amount*100 is cleaned to 15 significant digits before rounding, so a decimal tie that binary floats store just
 * below .5 (1.005, 12345678901.005) rounds up. This deviates from Serena's raw Math.round on purpose (recorded decision).
 * Per-line half-up, 2 decimals: half-up to 2 decimals, the rule of Serena's `amounts.ts` (round2), made immune to binary noise (1.005 -> 1.01). */
export const ROUNDING = "per_line_half_up_2" as const;

export function round2(n: number): number {
  const scaled = Number((Math.abs(n) * 100).toPrecision(15));
  return (Math.sign(n) * Math.round(scaled)) / 100 || 0;
}
