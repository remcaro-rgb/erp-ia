// What a tool hands the model is capped (rule 17: consult results are capped and masked): at most `MAX_RESULT_ROWS`
// list entries and about `MAX_RESULT_BYTES` of JSON, with `truncated: true` when something was cut. And what the
// conversation stores never holds a confirmation token (the card's bearer secret): only the card id.

export const MAX_RESULT_ROWS = 50;
export const MAX_RESULT_BYTES = 16 * 1024;

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

/** `value` within the caps; a cut result says `truncated: true`. */
export function capResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length <= MAX_RESULT_ROWS && size(value) <= MAX_RESULT_BYTES) return value;
    return capResult({ items: value, truncated: true });
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const listKey = Object.keys(record).find((key) => Array.isArray(record[key]));
    if (listKey !== undefined) {
      const list = record[listKey] as unknown[];
      let kept = list.slice(0, MAX_RESULT_ROWS);
      let out: Record<string, unknown> = { ...record, [listKey]: kept };
      if (kept.length < list.length) out.truncated = true;
      while (size(out) > MAX_RESULT_BYTES && kept.length > 0) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        out = { ...record, [listKey]: kept, truncated: true };
      }
      if (size(out) <= MAX_RESULT_BYTES) return out;
    } else if (size(value) <= MAX_RESULT_BYTES) {
      return value;
    }
  } else if (size(value) <= MAX_RESULT_BYTES) {
    return value;
  }
  return { truncated: true, preview: JSON.stringify(value).slice(0, MAX_RESULT_BYTES - 64) };
}

/** A deep copy of `value` without the `token` of any confirmation card in it (`{ confirmationRequired: true, token }`). */
export function scrubTokens<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => scrubTokens(item)) as T;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key === "token" && record.confirmationRequired === true) continue;
      out[key] = scrubTokens(item);
    }
    return out as T;
  }
  return value;
}
