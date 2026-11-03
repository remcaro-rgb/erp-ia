import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { required, type Env } from "./target";

// Outgoing e-mail (rule 6, design §13 and §21; entity types spec 2026-11-02 §7), behind one interface:
//  - cloud: Resend's HTTP API (`RESEND_API_KEY` from the deployment's secrets / Supabase Vault, rule 12, never in code; `MAIL_FROM`
//    a sender of a domain verified in Resend). Plain `fetch`, no Vercel API. The user invitation (kernel.admin.user.create) still goes
//    out through Supabase Auth's own invite e-mail (`AuthAdmin.inviteUserByEmail`), not through this seam;
//  - docker: plain SMTP to the compose's Mailpit, or to the customer's relay on the private network (`SMTP_HOST`,
//    `SMTP_PORT`, optional `SMTP_USER`/`SMTP_PASS` with AUTH PLAIN, `MAIL_FROM`). TLS to a public relay is phase 6.
// The state e-mails and Notificar (Phase 2A.5 Task 12) send one message to several recipients with the record's PDF attached.

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer | Uint8Array;
}

export interface MailMessage {
  /** Addresses every recipient sees. The kernel's mails leave it empty and use `bcc` (ruling of 2026-11-02). */
  to?: string | string[];
  /**
   * Addresses that receive the message without being listed in any header: one SMTP RCPT each, Resend's `bcc`. With no `to`, the
   * message is addressed To the sender itself, so no recipient learns who else received it.
   */
  bcc?: string[];
  /** One line: line breaks are folded into spaces, never into a header of their own. */
  subject: string;
  /** Plain text body (UTF-8). */
  text: string;
  attachments?: MailAttachment[];
  /**
   * The same key never sends twice where the provider supports it (Resend's `Idempotency-Key`, 24 h); the state e-mails pass the
   * outbox event id. SMTP ignores it (the caller's log keeps the send once per event).
   */
  idempotencyKey?: string;
}

/** What the provider answered: its message id when it gives one (Resend's `id`, the SMTP server's queue reply). */
export interface MailResult {
  providerId?: string;
}

export interface Mailer {
  readonly transport: "cloud" | "smtp";
  send(message: MailMessage): Promise<MailResult>;
}

/**
 * Resend refused a request because its Idempotency-Key was already used (https://resend.com/docs/dashboard/emails/idempotency-keys):
 * `invalid_idempotent_request` — an earlier request with this key had a different body (and was processed); `concurrent_idempotent_requests`
 * — the earlier one is still running (retry later). The caller decides what that means for its log.
 */
export class MailIdempotencyError extends Error {
  constructor(readonly reason: "invalid_idempotent_request" | "concurrent_idempotent_requests", message: string) {
    super(message);
    this.name = "MailIdempotencyError";
  }
}

const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;
const hasLineBreak = (value: string) => /[\r\n]/.test(value);
/** A header value on one line: CR / LF (and the spaces around them) become one space. */
const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ");
const ASCII = /^[\x20-\x7e]*$/;
/** Base64 encoded words carry at most 45 bytes: `=?UTF-8?B?` + 60 characters + `?=` = 72 ≤ 75 (RFC 2047 §2). */
const WORD_BYTES = 45;

/**
 * A header value as RFC 2047 encoded words when it is not plain ASCII: split on character boundaries into words of at most 75
 * characters, folded with CRLF + space (RFC 5322 §2.2.3), so no line passes the 78/998 character limits.
 */
export function encodeHeader(value: string): string {
  const line = oneLine(value);
  if (ASCII.test(line)) return line;
  const words: string[] = [];
  let chunk = "";
  for (const char of line) {
    if (Buffer.byteLength(chunk + char, "utf8") > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** An attachment's name as ASCII (accents dropped, anything else `_`), for the plain `filename=` parameter. */
const asciiName = (name: string) =>
  oneLine(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");

/** RFC 2231 percent-encoding: encodeURIComponent leaves ' ( ) * ! as they are; attribute-char excludes them, so they are encoded too (n6). */
const rfc2231 = (value: string) => encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `name="…"` and `filename="…"`, plus `filename*=UTF-8''…` (RFC 2231) when the name is not ASCII. */
function fileParameters(name: string): { type: string; disposition: string } {
  const plain = asciiName(name);
  const extended = ASCII.test(oneLine(name)) && !/["\\]/.test(name) ? "" : `; filename*=UTF-8''${rfc2231(oneLine(name))}`;
  return { type: `name="${plain}"`, disposition: `filename="${plain}"${extended}` };
}

interface Recipients {
  to: string[];
  bcc: string[];
}

/** The message's recipients, checked: at least one in to or bcc, each a bare address (no display name, no header injection). */
function recipientsOf(message: MailMessage): Recipients {
  const to = message.to === undefined ? [] : Array.isArray(message.to) ? message.to : [message.to];
  const bcc = message.bcc ?? [];
  if (to.length + bcc.length === 0) throw new Error("Mailer: no recipient");
  for (const address of [...to, ...bcc]) if (typeof address !== "string" || !ADDRESS.test(address) || hasLineBreak(address)) throw new Error(`Mailer: invalid address "${String(address)}"`);
  for (const file of message.attachments ?? []) if (hasLineBreak(file.contentType)) throw new Error(`Mailer: invalid attachment type "${file.contentType}"`);
  return { to, bcc };
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Resend's API root; the default is the public one. */
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** The cloud Mailer: one POST /emails per message (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly transport = "cloud" as const;

  constructor(private readonly options: ResendOptions) {
    if (!ADDRESS.test(options.from) || hasLineBreak(options.from)) throw new Error(`Mailer: invalid address "${options.from}"`);
  }

  async send(message: MailMessage): Promise<MailResult> {
    const { to, bcc } = recipientsOf(message);
    // Resend needs a `to`: with Bcc only, the sender itself (ruling of 2026-11-02: the recipients never see each other).
    const body: Record<string, unknown> = { from: this.options.from, to: to.length > 0 ? to : [this.options.from], subject: oneLine(message.subject), text: message.text };
    if (bcc.length > 0) body.bcc = bcc;
    if (message.attachments && message.attachments.length > 0) {
      body.attachments = message.attachments.map((file) => ({ filename: oneLine(file.filename), content: Buffer.from(file.content).toString("base64"), content_type: file.contentType }));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" };
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey;
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${(this.options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
    const detail = typeof answer.message === "string" ? `: ${answer.message}` : "";
    if (response.status === 409 && (answer.name === "invalid_idempotent_request" || answer.name === "concurrent_idempotent_requests")) {
      throw new MailIdempotencyError(answer.name, `Mailer: Resend answered 409 ${answer.name}${detail}`);
    }
    if (!response.ok) throw new Error(`Mailer: Resend answered ${response.status}${detail}`);
    return typeof answer.id === "string" ? { providerId: answer.id } : {};
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  from: string;
  user?: string;
  pass?: string;
  /** The name this client gives in EHLO. */
  helo?: string;
  timeoutMs?: number;
}

/** A minimal SMTP client (RFC 5321): one message per connection, no pipelining. */
export class SmtpMailer implements Mailer {
  readonly transport = "smtp" as const;

  constructor(private readonly options: SmtpOptions) {}

  async send(message: MailMessage): Promise<MailResult> {
    const { from } = this.options;
    if (!ADDRESS.test(from) || hasLineBreak(from)) throw new Error(`Mailer: invalid address "${from}"`);
    const { to, bcc } = recipientsOf(message);

    const session = await SmtpSession.open(this.options);
    try {
      await session.expect(220);
      await session.command(`EHLO ${this.options.helo ?? "erp-ia"}`, 250);
      if (this.options.user) {
        const token = Buffer.from(`\0${this.options.user}\0${this.options.pass ?? ""}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, 235);
      }
      await session.command(`MAIL FROM:<${from}>`, 250);
      for (const address of [...to, ...bcc]) await session.command(`RCPT TO:<${address}>`, 250, 251);
      await session.command("DATA", 354);
      const queued = await session.command(`${this.render(message, to)}\r\n.`, 250);
      await session.command("QUIT", 221);
      const id = queued.slice(4).trim();
      return id ? { providerId: id } : {};
    } finally {
      session.close();
    }
  }

  /** The message as sent: Bcc addresses are in the envelope only, never in a header; with no `to`, To is the sender. */
  private render(message: MailMessage, to: string[]): string {
    const domain = this.options.from.split("@")[1];
    const headers = [
      `From: ${this.options.from}`,
      `To: ${to.length > 0 ? to.join(", ") : this.options.from}`,
      `Subject: ${encodeHeader(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@${domain}>`,
      "MIME-Version: 1.0",
    ];
    // CRLF line ends, and a line that starts with a dot gets a second one (RFC 5321 §4.5.2).
    const text = message.text
      .replace(/\r\n|\r|\n/g, "\n")
      .split("\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
      return `${headers.join("\r\n")}\r\n\r\n${text}`;
    }
    // multipart/mixed (RFC 2046): the text, then each file in base64 lines of 76 characters.
    const boundary = `erp-${randomUUID()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n"),
      ...attachments.map((file) => {
        const names = fileParameters(file.filename);
        return [
          `Content-Type: ${file.contentType}; ${names.type}`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; ${names.disposition}`,
          "",
          (Buffer.from(file.content).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
        ].join("\r\n");
      }),
    ];
    return `${headers.join("\r\n")}\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}`).join("\r\n")}\r\n--${boundary}--`;
  }
}

/** One SMTP connection: complete replies (multi-line ones joined) are queued as they arrive. */
class SmtpSession {
  private buffer = "";
  private lines: string[] = [];
  private readonly replies: string[] = [];
  private waiting: ((reply: string) => void) | undefined;
  private failure: Error | undefined;
  private failed: ((error: Error) => void) | undefined;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("timeout", () => this.fail(new Error("Mailer: SMTP server timed out")));
    socket.on("close", () => this.fail(new Error("Mailer: SMTP connection closed")));
  }

  static open(options: SmtpOptions): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      socket.setTimeout(options.timeoutMs ?? 30_000);
      socket.once("connect", () => resolve(new SmtpSession(socket)));
      socket.once("error", reject);
    });
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      // "250-..." continues a reply, "250 ..." ends it.
      if (line.length < 4 || line[3] !== "-") {
        const reply = this.lines.join("\n");
        this.lines = [];
        if (this.waiting) {
          const deliver = this.waiting;
          this.waiting = undefined;
          this.failed = undefined;
          deliver(reply);
        } else this.replies.push(reply);
      }
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    const reject = this.failed;
    this.waiting = undefined;
    this.failed = undefined;
    reject?.(error);
  }

  private next(): Promise<string> {
    const queued = this.replies.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
    });
  }

  async expect(...codes: number[]): Promise<string> {
    const reply = await this.next();
    if (!codes.includes(Number(reply.slice(0, 3)))) throw new Error(`Mailer: SMTP server answered "${reply}"`);
    return reply;
  }

  async command(line: string, ...codes: number[]): Promise<string> {
    this.socket.write(`${line}\r\n`);
    return this.expect(...codes);
  }

  close() {
    this.socket.removeAllListeners("close");
    this.socket.destroy();
  }
}

/** The cloud Mailer: Resend, keyed by `RESEND_API_KEY` (the deployment's secret, rule 12), sending as `MAIL_FROM`. */
export function cloudMailer(env: Env = process.env): Mailer {
  const apiKey = required(env, "RESEND_API_KEY", "for the cloud Mailer (Resend; a deployment secret, never in code)");
  const from = required(env, "MAIL_FROM", "for the cloud Mailer (a sender of a domain verified in Resend)");
  return new ResendMailer({ apiKey, from, ...(env.RESEND_API_URL ? { baseUrl: env.RESEND_API_URL } : {}) });
}

export function dockerMailer(env: Env = process.env): Mailer {
  const host = required(env, "SMTP_HOST", "for ERP_TARGET=docker (Mailpit in the compose, or the customer relay)");
  const port = Number(env.SMTP_PORT ?? "25");
  if (!Number.isInteger(port) || port <= 0) throw new Error(`SMTP_PORT must be a port number (got "${env.SMTP_PORT}")`);
  const from = required(env, "MAIL_FROM", "for ERP_TARGET=docker (the sender address)");
  return new SmtpMailer({ host, port, from, user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined });
}
