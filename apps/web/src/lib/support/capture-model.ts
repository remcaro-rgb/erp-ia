// What a support ticket carries about the screen it was filed from (design §8): the route, the text the user had
// selected, the latest audit entries (none yet in phase 1) and the console errors. Pure rules with the same bounds as
// the `support.ticket.create` input; capture.ts feeds them from the window.

export const MAX_ROUTE = 500;
export const MAX_SELECTION = 2000;
export const MAX_ERRORS = 20;
export const MAX_ERROR_LENGTH = 1000;

/** The `context` input of `support.ticket.create`. */
export interface CapturedContext {
  route: string;
  selection: string;
  lastAuditIds: string[];
  consoleErrors: string[];
}

/** What the window has shown so far, outside the support screen. */
export interface CaptureState {
  route: string;
  selection: string;
  errors: string[];
}

export const emptyCapture = (): CaptureState => ({ route: "", selection: "", errors: [] });

/** The support screen itself: a ticket is about the screen the user came from, never this one. */
export const isSupportRoute = (pathname: string): boolean => {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return path === "/support" || path.startsWith("/support/");
};

export function withRoute(state: CaptureState, pathname: string): CaptureState {
  return isSupportRoute(pathname) ? state : { ...state, route: pathname.slice(0, MAX_ROUTE) };
}

/** Keeps the latest non-empty selection made away from the support screen; typing in the ticket form must not replace it. */
export function withSelection(state: CaptureState, text: string, pathname: string): CaptureState {
  const selection = text.trim();
  return selection === "" || isSupportRoute(pathname) ? state : { ...state, selection: selection.slice(0, MAX_SELECTION) };
}

export function withError(state: CaptureState, message: string): CaptureState {
  const text = message.trim();
  return text === "" ? state : { ...state, errors: [...state.errors, text.slice(0, MAX_ERROR_LENGTH)].slice(-MAX_ERRORS) };
}

const SECRET_KEY = /token|secret|password|authorization|cookie/i;
/** `key=value` / `key: value` text whose key looks like a secret (an optional `Bearer ` is part of the value). */
const SECRET_TEXT = /\b([\w-]*(?:token|secret|password|authorization|cookie)[\w-]*)(\s*[:=]\s*)(?:Bearer\s+)?[^\s,;&"']+/gi;
const REDACTED = "[redacted]";
const MAX_DEPTH = 3;
const MAX_ENTRIES = 20;

const redactText = (text: string): string => text.replace(SECRET_TEXT, `$1$2${REDACTED}`);

/** A bounded JSON-like rendering: strings cut first, at most 20 entries and 3 levels, secret keys redacted, cycles harmless. */
function render(value: unknown, depth: number): string {
  if (typeof value === "string") return JSON.stringify(redactText(value.slice(0, MAX_ERROR_LENGTH)));
  if (value instanceof Error) return JSON.stringify(redactText(`${value.name}: ${value.message}`.slice(0, MAX_ERROR_LENGTH)));
  if (value === null || typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return '"[…]"';
  if (Array.isArray(value)) return `[${value.slice(0, MAX_ENTRIES).map((item) => render(item, depth + 1)).join(",")}]`;
  const entries = Object.keys(value)
    .slice(0, MAX_ENTRIES)
    .map((key) => `${JSON.stringify(key.slice(0, 100))}:${SECRET_KEY.test(key) ? `"${REDACTED}"` : render((value as Record<string, unknown>)[key], depth + 1)}`);
  return `{${entries.join(",")}}`;
}

/**
 * One line for what `console.error(...)` was called with. Each argument is cut to the bound before anything is
 * stringified, the values of keys that look like secrets (token, secret, password, authorization, cookie) are
 * replaced, and so is the value after such a name in plain text.
 */
export function describeError(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return redactText(arg.slice(0, MAX_ERROR_LENGTH));
      if (arg instanceof Error) return redactText(`${arg.name}: ${arg.message}`.slice(0, MAX_ERROR_LENGTH));
      return render(arg, 0).slice(0, MAX_ERROR_LENGTH);
    })
    .join(" ")
    .slice(0, MAX_ERROR_LENGTH);
}

/** The context to send: the live selection wins over the remembered one, and a user who never left the support screen gets that screen. */
export function captured(state: CaptureState, now: { pathname: string; selection: string }): CapturedContext {
  const live = isSupportRoute(now.pathname) ? "" : now.selection.trim();
  return {
    route: state.route || now.pathname.slice(0, MAX_ROUTE),
    selection: (live || state.selection).slice(0, MAX_SELECTION),
    lastAuditIds: [],
    consoleErrors: [...state.errors],
  };
}
