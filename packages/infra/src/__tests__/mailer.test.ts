import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudMailer, encodeHeader, MailIdempotencyError, ResendMailer, SmtpMailer } from "../mailer";
import { infra } from "../index";

// The cloud Mailer (rule 6, design §13; entity types spec 2026-11-02 §7): Resend's HTTP API, the key from the environment (Vault /
// the deployment's secrets, rule 12), never in code. The Docker Mailer speaks SMTP to Mailpit; both carry several recipients and
// PDF attachments (the state e-mails and Notificar of Phase 2A.5 Task 12).

const PDF = Buffer.from("%PDF-1.4 prueba");

describe("ResendMailer", () => {
  it("posts the expected payload to Resend and answers the provider id", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "re_123" }), { status: 200, headers: { "content-type": "application/json" } }));
    const mailer = new ResendMailer({ apiKey: "re_test_key", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch });

    const result = await mailer.send({
      to: ["ana@cafe.co", "luis@cafe.co"],
      subject: "Pedido PD-7 · Aprobado",
      text: "Adjuntamos el documento.",
      attachments: [{ filename: "pedido.pdf", contentType: "application/pdf", content: PDF }],
      idempotencyKey: "evt-1",
    });

    expect(result).toEqual({ providerId: "re_123" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("evt-1");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "erp@cafedelnorte.co",
      to: ["ana@cafe.co", "luis@cafe.co"],
      subject: "Pedido PD-7 · Aprobado",
      text: "Adjuntamos el documento.",
      attachments: [{ filename: "pedido.pdf", content: PDF.toString("base64"), content_type: "application/pdf" }],
    });
  });

  it("sends a single recipient as a list and no idempotency header when none is given", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "re_9" }), { status: 200 }));
    await new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch }).send({ to: "ana@cafe.co", subject: "x", text: "y" });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("idempotency-key")).toBe(false);
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["ana@cafe.co"]);
    expect(body.attachments).toBeUndefined();
  });

  it("sends the recipients in bcc and the sender alone in to (recipients never see each other, ruling 2026-11-02)", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "re_b" }), { status: 200 }));
    await new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch }).send({ bcc: ["ana@cafe.co", "luis@cafe.co"], subject: "x", text: "y" });
    const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.to).toEqual(["erp@cafedelnorte.co"]);
    expect(body.bcc).toEqual(["ana@cafe.co", "luis@cafe.co"]);
  });

  it("strips line breaks from the subject instead of letting them reach a header", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "re_s" }), { status: 200 }));
    await new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch }).send({ to: "ana@cafe.co", subject: "Pedido\r\nBcc: x@y.z", text: "y" });
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).subject).toBe("Pedido Bcc: x@y.z");
  });

  it("answers Resend's idempotency conflicts with a typed error: a different body for the key, or the first request still running", async () => {
    for (const name of ["invalid_idempotent_request", "concurrent_idempotent_requests"] as const) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ name, message: "conflict" }), { status: 409 }));
      const error = await new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch })
        .send({ to: "ana@cafe.co", subject: "x", text: "y", idempotencyKey: "evt-9" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailIdempotencyError);
      expect((error as MailIdempotencyError).reason).toBe(name);
    }
  });

  it("fails with Resend's status and message, so the outbox retries", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }), { status: 422 }));
    const mailer = new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch });
    await expect(mailer.send({ to: "ana@cafe.co", subject: "x", text: "y" })).rejects.toThrow(/Resend answered 422.*Invalid `to` field/);
  });

  it("refuses an invalid address or a subject with a line break before calling Resend", async () => {
    const fetcher = vi.fn();
    const mailer = new ResendMailer({ apiKey: "k", from: "erp@cafedelnorte.co", fetcher: fetcher as unknown as typeof fetch });
    await expect(mailer.send({ to: ["ana@cafe.co", "no es correo"], subject: "x", text: "y" })).rejects.toThrow(/invalid address/);
    await expect(mailer.send({ to: [], subject: "x", text: "y" })).rejects.toThrow(/no recipient/);
    await expect(mailer.send({ to: [], bcc: [], subject: "x", text: "y" })).rejects.toThrow(/no recipient/);
    await expect(mailer.send({ bcc: ["no es correo"], subject: "x", text: "y" })).rejects.toThrow(/invalid address/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("cloudMailer and infra.mailer", () => {
  it("needs the Resend key and the sender from the environment", () => {
    expect(() => cloudMailer({ MAIL_FROM: "erp@cafedelnorte.co" })).toThrow(/RESEND_API_KEY is required/);
    expect(() => cloudMailer({ RESEND_API_KEY: "k" })).toThrow(/MAIL_FROM is required/);
    expect(cloudMailer({ RESEND_API_KEY: "k", MAIL_FROM: "erp@cafedelnorte.co" })).toBeInstanceOf(ResendMailer);
  });

  it("picks Resend on vercel and SMTP on docker", () => {
    expect(infra.mailer({ RESEND_API_KEY: "k", MAIL_FROM: "erp@cafedelnorte.co" }).transport).toBe("cloud");
    expect(infra.mailer({ ERP_TARGET: "docker", SMTP_HOST: "mail", SMTP_PORT: "1025", MAIL_FROM: "erp@cafedelnorte.test" }).transport).toBe("smtp");
  });
});

// A tiny SMTP server that records the dialogue (as smtp.test.ts does).
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});
function sink(): Promise<{ port: number; received: { commands: string[]; data: string } }> {
  const received = { commands: [] as string[], data: "" };
  server = createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued as M1\r\n");
          } else received.data += `${line}\r\n`;
          continue;
        }
        received.commands.push(line);
        if (line.startsWith("EHLO")) socket.write("250-test\r\n250 8BITMIME\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, received });
    });
  });
}

describe("SmtpMailer with several recipients and an attachment", () => {
  it("sends one message: one RCPT per recipient, multipart/mixed with the text and the base64 PDF", async () => {
    const { port, received } = await sink();
    const mailer = new SmtpMailer({ host: "127.0.0.1", port, from: "erp@cafedelnorte.test" });
    await mailer.send({
      to: ["ana@cafe.co", "luis@cafe.co"],
      subject: "Pedido PD-7 · Aprobado",
      text: "Adjuntamos el documento.",
      attachments: [{ filename: "pedido.pdf", contentType: "application/pdf", content: PDF }],
    });
    expect(received.commands).toEqual(["EHLO erp-ia", "MAIL FROM:<erp@cafedelnorte.test>", "RCPT TO:<ana@cafe.co>", "RCPT TO:<luis@cafe.co>", "DATA", "QUIT"]);
    expect(received.data).toContain("To: ana@cafe.co, luis@cafe.co\r\n");
    expect(received.data).toMatch(/Content-Type: multipart\/mixed; boundary="([^"]+)"\r\n/);
    expect(received.data).toContain("Content-Type: application/pdf; name=\"pedido.pdf\"\r\n");
    expect(received.data).toContain("Content-Disposition: attachment; filename=\"pedido.pdf\"\r\n");
    expect(received.data).toContain(PDF.toString("base64"));
    expect(received.data).toContain("Adjuntamos el documento.");
  });
});

describe("SmtpMailer with Bcc and encoded headers", () => {
  it("delivers to every Bcc address (one RCPT each) without any header listing them; To is the sender", async () => {
    const { port, received } = await sink();
    await new SmtpMailer({ host: "127.0.0.1", port, from: "erp@cafedelnorte.test" }).send({ bcc: ["ana@cafe.co", "luis@cafe.co"], subject: "x", text: "y" });
    expect(received.commands).toEqual(["EHLO erp-ia", "MAIL FROM:<erp@cafedelnorte.test>", "RCPT TO:<ana@cafe.co>", "RCPT TO:<luis@cafe.co>", "DATA", "QUIT"]);
    const headers = received.data.split("\r\n\r\n")[0]!;
    expect(headers).toContain("To: erp@cafedelnorte.test");
    expect(headers).not.toMatch(/ana@cafe\.co|luis@cafe\.co/);
    expect(headers).not.toMatch(/^Bcc:/im);
  });

  it("folds a long non-ASCII subject into encoded words of at most 75 characters (RFC 2047) and names a non-ASCII file per RFC 2231", async () => {
    const { port, received } = await sink();
    const subject = `${"Café del Norte · Aprobado ".repeat(12)}fin`;
    await new SmtpMailer({ host: "127.0.0.1", port, from: "erp@cafedelnorte.test" }).send({
      to: "ana@cafe.co", subject: "Café del Norte · Aprobado\r\nBcc: x@y.z", text: "y",
      attachments: [{ filename: "Cotización Café.pdf", contentType: "application/pdf", content: PDF }],
    });
    const headers = received.data.split("\r\n\r\n")[0]!;
    expect(headers).toContain(`Subject: ${encodeHeader("Café del Norte · Aprobado Bcc: x@y.z")}`);
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(received.data).toContain(`filename*=UTF-8''${encodeURIComponent("Cotización Café.pdf")}`);
    expect(received.data).toContain('filename="Cotizacion Cafe.pdf"');

    // n6: RFC 2231 attribute-char excludes ' * ( ) and ! is left escaped too: every one is percent-encoded.
    const { port: port2, received: received2 } = await sink();
    await new SmtpMailer({ host: "127.0.0.1", port: port2, from: "erp@cafedelnorte.test" }).send({
      to: "ana@cafe.co", subject: "x", text: "y",
      attachments: [{ filename: "Cotización (final)*'v2'!.pdf", contentType: "application/pdf", content: PDF }],
    });
    expect(received2.data).toContain("filename*=UTF-8''Cotizaci%C3%B3n%20%28final%29%2A%27v2%27%21.pdf");

    const folded = encodeHeader(subject);
    const words = folded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = words.map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, "base64").toString("utf8")).join("");
    expect(decoded).toBe(subject);
    expect(encodeHeader("Café del Norte · Aprobado")).toBe(`=?UTF-8?B?${Buffer.from("Café del Norte · Aprobado").toString("base64")}?=`);
    expect(encodeHeader("plain ascii")).toBe("plain ascii");
  });
});
