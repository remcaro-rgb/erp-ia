export class PathError extends Error {
  constructor(readonly code: "invalid_path" | "multiple_wildcards", path: string) {
    super(`${code}: ${path}`);
    this.name = "PathError";
  }
}

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[\*\])?$/;

const walk = (value: unknown, segments: string[], path: string): unknown => {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const match = SEGMENT.exec(head);
  if (!match) throw new PathError("invalid_path", path);
  const next = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[match[1]!] : undefined;
  if (!match[2]) return next === undefined ? undefined : walk(next, rest, path);
  if (!Array.isArray(next)) return undefined;
  return rest.length === 0 ? next : next.map((entry) => walk(entry, rest, path));
};

/**
 * JSONPath subset (design §5.2): `$.a.b`, `$.a[*]` once per path, `$` the base itself, `$$.x` the root payload inside a
 * forEach. Strings without a leading `$` are literals. Relative paths resolve against `item` when one is given.
 */
export function resolvePath(payload: unknown, path: string, item?: unknown): unknown {
  if (!path.startsWith("$")) return path;
  if ((path.match(/\[\*\]/g) ?? []).length > 1) throw new PathError("multiple_wildcards", path);
  let base = item === undefined ? payload : item;
  let rest = path;
  if (path === "$$" || path.startsWith("$$.")) {
    base = payload;
    rest = path.slice(1);
  }
  if (rest === "$") return base;
  if (!rest.startsWith("$.")) throw new PathError("invalid_path", path);
  return walk(base, rest.slice(2).split("."), path);
}

/** `{{a.b}}` is relative to the item (or the payload), `{{$$.a}}` to the root; a missing or non-scalar value is "". */
export function interpolate(text: string, payload: unknown, item?: unknown): string {
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
    const value = resolvePath(payload, expr.startsWith("$") ? expr : `$.${expr}`, item);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  });
}
