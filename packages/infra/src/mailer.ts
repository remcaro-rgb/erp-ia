import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { required, type Env } from "./target";

// Outgoing e-mail (rule 6, design §13 and §21), behind one interface:
//  - cloud: the Resend adapter is a phase 2 deliverable; until then the cloud Mailer refuses to send. The only mail
//    phase 1 sends, the user invitation (kernel.admin.user.create, Task 19), goes out through Supabase Auth's own
//    invite e-mail (`AuthAdmin.inviteUserByEmail`), not through this seam;
//  - docker: plain SMTP to the compose's Mailpit, or to the customer's relay on the private network (`SMTP_HOST`,
//    `SMTP_PORT`, optional `SMTP_USER`/`SMTP_PASS` with AUTH PLAIN, `MAIL_FROM`). TLS to a public relay is phase 6.

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text body (UTF-8). */
  text: string;
}

export interface Mailer {
  readonly transport: "cloud" | "smtp";
  send(message: MailMessage): Promise<void>;
}

/** The cloud Mailer of phase 1: wired to nothing yet, and says so instead of dropping the message. */
export class CloudMailer implements Mailer {
  readonly transport = "cloud" as const;
  async send(): Promise<void> {
    throw new Error("Mailer: the cloud transport (Resend) is not wired in phase 1; invitations go through Supabase Auth");
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

const ADDRESS = /^[^\s<>@]+@[^\s<>@]+$/;
const hasLineBreak = (value: string) => /[\r\n]/.test(value);
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);

/** A minimal SMTP client (RFC 5321): one message per connection, no pipelining. */
export class SmtpMailer implements Mailer {
  readonly transport = "smtp" as const;

  constructor(private readonly options: SmtpOptions) {}

  async send(message: MailMessage): Promise<void> {
    const { from } = this.options;
    for (const address of [from, message.to]) {
      if (!ADDRESS.test(address) || hasLineBreak(address)) throw new Error(`Mailer: invalid address "${address}"`);
    }
    if (hasLineBreak(message.subject)) throw new Error("Mailer: invalid subject (line break)");

    const session = await SmtpSession.open(this.options);
    try {
      await session.expect(220);
      await session.command(`EHLO ${this.options.helo ?? "erp-ia"}`, 250);
      if (this.options.user) {
        const token = Buffer.from(`\0${this.options.user}\0${this.options.pass ?? ""}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, 235);
      }
      await session.command(`MAIL FROM:<${from}>`, 250);
      await session.command(`RCPT TO:<${message.to}>`, 250, 251);
      await session.command("DATA", 354);
      await session.command(`${this.render(message)}\r\n.`, 250);
      await session.command("QUIT", 221);
    } finally {
      session.close();
    }
  }

  private render(message: MailMessage): string {
    const domain = this.options.from.split("@")[1];
    const headers = [
      `From: ${this.options.from}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeader(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@${domain}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
    ];
    // CRLF line ends, and a line that starts with a dot gets a second one (RFC 5321 §4.5.2).
    const body = message.text
      .replace(/\r\n|\r|\n/g, "\n")
      .split("\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    return `${headers.join("\r\n")}\r\n\r\n${body}`;
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

export function cloudMailer(): Mailer {
  return new CloudMailer();
}

export function dockerMailer(env: Env = process.env): Mailer {
  const host = required(env, "SMTP_HOST", "for ERP_TARGET=docker (Mailpit in the compose, or the customer relay)");
  const port = Number(env.SMTP_PORT ?? "25");
  if (!Number.isInteger(port) || port <= 0) throw new Error(`SMTP_PORT must be a port number (got "${env.SMTP_PORT}")`);
  const from = required(env, "MAIL_FROM", "for ERP_TARGET=docker (the sender address)");
  return new SmtpMailer({ host, port, from, user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined });
}
