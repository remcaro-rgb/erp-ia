import { CostError } from "./average";

// Landed cost allocation (plan 2B Task 9): the arithmetic that splits an amount over the lines of a receipt. Integers only (cents, and the
// base scaled to 4 decimals) through BigInt, so the split never depends on floating point and always adds up to the total.

/**
 * Splits `totalCents` (a positive whole number of cents) over `bases` (non-negative whole numbers: a line's value in cents, its quantity
 * or weight scaled to 4 decimals) in proportion to each base, by largest remainder: every line gets the floor of its exact share, and
 * the cents left over go one each to the lines with the largest remainders (ties to the earlier line). The parts add up to
 * `totalCents` exactly; a line whose base is 0 gets 0.
 */
export function distribute(totalCents: number, bases: readonly number[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new CostError("invalid_quantity", `El valor a repartir debe ser un número positivo de centavos (${totalCents})`);
  if (bases.some((b) => !Number.isSafeInteger(b) || b < 0)) throw new CostError("invalid_quantity", "La base del reparto no puede ser negativa");
  const sum = bases.reduce((s, b) => s + BigInt(b), BigInt(0));
  if (sum <= BigInt(0)) throw new CostError("invalid_quantity", "La base del reparto suma cero: no hay a quién repartir el valor");
  const total = BigInt(totalCents);
  const shares = bases.map((b, index) => {
    const exact = total * BigInt(b);
    return { index, part: exact / sum, rest: exact % sum };
  });
  let left = Number(total - shares.reduce((s, x) => s + x.part, BigInt(0)));
  const order = [...shares].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const share of order) {
    if (left === 0) break;
    if (bases[share.index] === 0) continue;
    share.part += BigInt(1);
    left -= 1;
  }
  return shares.map((s) => Number(s.part));
}
