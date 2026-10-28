import type { UIMessage } from "ai";
import type { GridStateInput } from "../grid/types";

// The pure side of the assistant UI (design §7.1). What the model says and what its tools return arrive from outside the
// trust boundary of the page: text is drawn as text and markdown-lite (never HTML, never a remote image, links only to
// the app's own routes), and tool results are read as structured data to draw cards and tables, never as instructions.

/** What the user is looking at, sent with every turn (the route, and the record when on `/r/<entity>/<id>`). */
export interface ScreenContext {
  route?: string;
  record?: { entity: string; id: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The screen context of the page at `href`. */
export function screenOf(href: string): ScreenContext {
  const route = href.split("?")[0]!.split("#")[0]!;
  const record = /^\/r\/([^/]+)\/([^/]+)$/.exec(route);
  if (record && UUID.test(record[2]!)) return { route, record: { entity: decodeURIComponent(record[1]!), id: record[2]! } };
  return { route };
}

/** `core__party__create` → `core.party.create`. */
export const processIdOfToolName = (name: string): string => name.replaceAll("__", ".");

/**
 * A screen of the app that text from the model may lead to: starts with one `/`, no scheme, no backslash, no whitespace
 * or control characters, and never the app's own API (`/api/...`): a link of the model is a page, not a request.
 */
export function isInternalHref(href: string): boolean {
  if (href.length === 0 || href.length > 300 || !href.startsWith("/") || href.startsWith("//")) return false;
  const path = href.split(/[?#]/)[0]!.toLowerCase();
  if (path === "/api" || path.startsWith("/api/")) return false;
  for (const char of href) {
    const code = char.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || char === "\\") return false;
  }
  return true;
}

// ---- tool results ----

export interface ConfirmationPreview {
  title: string;
  effects: { label: string; value: string }[];
  permission: string;
  stepUp: boolean;
}

export interface ConfirmationOutput {
  cardId: string;
  preview: ConfirmationPreview;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The card a write-kind tool proposed. The raw token (the card's bearer secret) is never read: the card id is the handle. */
export function asConfirmation(output: unknown): ConfirmationOutput | null {
  if (!isRecord(output) || output.confirmationRequired !== true) return null;
  const { cardId, preview } = output;
  if (typeof cardId !== "string" || !UUID.test(cardId) || !isRecord(preview)) return null;
  if (typeof preview.title !== "string" || !Array.isArray(preview.effects) || typeof preview.permission !== "string") return null;
  const effects = preview.effects.filter(isRecord).map((e) => ({ label: String(e.label ?? ""), value: String(e.value ?? "") }));
  return { cardId, preview: { title: preview.title, effects, permission: preview.permission, stepUp: preview.stepUp === true } };
}

export interface ResultColumn {
  field: string;
  label?: string;
  /** Registry type (`money`, `datetime`, `boolean`…). */
  type?: string;
  /** The caller's access to the field, as the grid has it: a masked field shows ••••••, a hidden one has no column. */
  mode?: "visible" | "masked" | "hidden";
}

export interface QueryResult {
  entity?: string;
  rows: Record<string, unknown>[];
  columns?: ResultColumn[];
  total?: number;
  truncated: boolean;
}

/** The rows `kernel.data.query` returned. */
export function asQueryResult(output: unknown): QueryResult | null {
  if (!isRecord(output) || !Array.isArray(output.rows)) return null;
  const result: QueryResult = { rows: output.rows.filter(isRecord), truncated: output.truncated === true };
  if (typeof output.entity === "string") result.entity = output.entity;
  if (typeof output.total === "number") result.total = output.total;
  if (Array.isArray(output.columns)) {
    const columns = output.columns
      .filter(isRecord)
      .filter((c) => typeof c.field === "string")
      .map((c): ResultColumn => ({
        field: c.field as string,
        ...(typeof c.label === "string" ? { label: c.label } : {}),
        ...(typeof c.type === "string" ? { type: c.type } : {}),
        ...(c.mode === "visible" || c.mode === "masked" || c.mode === "hidden" ? { mode: c.mode } : {}),
      }));
    if (columns.length > 0) result.columns = columns;
  }
  return result;
}

/** A navigation the assistant asked for (`ui__navigate`, `ui__open_record`): only a route of the app. */
export function asDirective(output: unknown): { href: string } | null {
  if (!isRecord(output) || (output.action !== "navigate" && output.action !== "open_record")) return null;
  return typeof output.href === "string" && isInternalHref(output.href) ? { href: output.href } : null;
}

/** The grid state of a `kernel.data.query` call, to open or export the same rows. */
export function gridStateOfQuery(input: unknown): GridStateInput {
  const q = isRecord(input) ? input : {};
  return {
    filters: Array.isArray(q.filters) ? (q.filters as NonNullable<GridStateInput["filters"]>) : [],
    sort: Array.isArray(q.sort) ? (q.sort as NonNullable<GridStateInput["sort"]>) : [],
    page: 1,
    pageSize: 50,
    ...(Array.isArray(q.columns) ? { columns: q.columns as string[] } : {}),
    ...(typeof q.search === "string" && q.search !== "" ? { search: q.search } : {}),
  };
}

// ---- cards ----

export interface CardState {
  /** `confirming`: the decision is on its way. */
  status: "pending" | "confirming" | "executed" | "rejected";
  /** Why a card ended rejected without the user rejecting it (`confirmation_expired`). */
  reason?: string;
  /** The code of the last refusal (`step_up_required`, `forbidden`…); the card stays confirmable. */
  error?: string;
}

/** The state a stored card has in a restored conversation. */
export function toolCardState(stored: { status?: unknown; reason?: unknown } | undefined): CardState {
  if (stored?.status === "executed") return { status: "executed" };
  if (stored?.status === "rejected") return typeof stored.reason === "string" ? { status: "rejected", reason: stored.reason } : { status: "rejected" };
  return { status: "pending" };
}

/** The text of the last user message. */
export function userTextOf(messages: readonly Pick<UIMessage, "role" | "parts">[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return (last?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

// ---- error codes ----

/** The catalogue key for what went wrong with a request, from the body of a refused response or an exception. */
export function errorKeyOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const start = message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start)) as { code?: unknown; details?: unknown };
      const detail = Array.isArray(body.details) && typeof body.details[0] === "string" ? body.details[0] : undefined;
      if (detail === "message_too_long" || detail === "conversation_not_found") return `agent.ui.errors.${detail}`;
      if (typeof body.code === "string") return `errors.${body.code}`;
    } catch {
      // Not our body: fall through.
    }
  }
  return error instanceof TypeError ? "errors.network" : "errors.unknown";
}

// ---- markdown-lite ----

export type Inline = { type: "text"; text: string } | { type: "strong"; text: string } | { type: "code"; text: string } | { type: "link"; text: string; href: string };
export type Block = { type: "p"; children: Inline[] } | { type: "ul"; items: Inline[][] };

// Every quantifier is bounded, so a hostile run of brackets or backticks costs a bounded scan per position (linear overall).
const URL_PART = String.raw`(?:[^()\s]|\([^()\s]{0,100}\)){0,300}`;
const INLINE = new RegExp(
  String.raw`!\[([^\]]{0,200})\]\(\s{0,5}${URL_PART}[^)]{0,200}\)|\[([^\]]{0,200})\]\((${URL_PART})\)|\*\*([^*]{1,300})\*\*|` + "`([^`]{1,300})`",
  "g",
);

/** Inline markdown-lite: **bold**, `code` and [label](/route). An image keeps its alt text; any other link keeps its label. */
export function inlineOf(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (node: Inline) => {
    const last = out.at(-1);
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else out.push(node);
  };
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > at) push({ type: "text", text: text.slice(at, match.index) });
    at = match.index + match[0].length;
    if (match[0].startsWith("![")) {
      if (match[1]) push({ type: "text", text: match[1] });
    } else if (match[3] !== undefined) {
      const label = match[2]!;
      if (isInternalHref(match[3])) push({ type: "link", text: label, href: match[3] });
      else if (label) push({ type: "text", text: label });
    } else if (match[4] !== undefined) push({ type: "strong", text: match[4] });
    else push({ type: "code", text: match[5]! });
  }
  if (at < text.length) push({ type: "text", text: text.slice(at) });
  return out;
}

/** Paragraphs and `-` / `*` bullet lists with inline markdown-lite. Nothing else is interpreted. */
export function parseRichText(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    let paragraph: string[] = [];
    let list: Inline[][] = [];
    const flushParagraph = () => {
      if (paragraph.length > 0) blocks.push({ type: "p", children: inlineOf(paragraph.join("\n")) });
      paragraph = [];
    };
    const flushList = () => {
      if (list.length > 0) blocks.push({ type: "ul", items: list });
      list = [];
    };
    for (const line of lines) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        list.push(inlineOf(bullet[1]!));
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}
