import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SmtpMailer } from "../mailer";

// The Docker target's Mailer speaks plain SMTP to the compose's Mailpit (or a customer relay on the private network).
// A tiny in-process SMTP server records the dialogue.

interface Received {
  commands: string[];
  data: string;
}

let server: Server | undefined;

function smtpServer(options: { rejectRcpt?: boolean } = {}): Promise<{ port: number; received: Received }> {
  const received: Received = { commands: [], data: "" };
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
            socket.write("250 queued\r\n");
          } else received.data += `${line}\r\n`;
          continue;
        }
        received.commands.push(line);
        if (line.startsWith("EHLO")) socket.write("250-test\r\n250 8BITMIME\r\n");
        else if (line.startsWith("RCPT") && options.rejectRcpt) socket.write("550 no such user\r\n");
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

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("SmtpMailer", () => {
  it("delivers one message: envelope, UTF-8 headers and a dot-stuffed body", async () => {
    const { port, received } = await smtpServer();
    const mailer = new SmtpMailer({ host: "127.0.0.1", port, from: "erp@cafedelnorte.test" });
    await mailer.send({ to: "ana@cafe.co", subject: "Invitación a Café del Norte", text: "Hola Ana\n.línea con punto" });

    expect(received.commands).toEqual(["EHLO erp-ia", "MAIL FROM:<erp@cafedelnorte.test>", "RCPT TO:<ana@cafe.co>", "DATA", "QUIT"]);
    expect(received.data).toContain("From: erp@cafedelnorte.test\r\n");
    expect(received.data).toContain("To: ana@cafe.co\r\n");
    expect(received.data).toContain(`Subject: =?UTF-8?B?${Buffer.from("Invitación a Café del Norte").toString("base64")}?=\r\n`);
    expect(received.data).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    // A body line that starts with a dot is doubled on the wire (RFC 5321 §4.5.2).
    expect(received.data).toContain("Hola Ana\r\n..línea con punto\r\n");
  });

  it("fails with the server's reply when a step is refused", async () => {
    const { port } = await smtpServer({ rejectRcpt: true });
    const mailer = new SmtpMailer({ host: "127.0.0.1", port, from: "erp@cafedelnorte.test" });
    await expect(mailer.send({ to: "nadie@cafe.co", subject: "x", text: "y" })).rejects.toThrow(/550 no such user/);
  });

  it("refuses header injection in the recipient or the subject", async () => {
    const mailer = new SmtpMailer({ host: "127.0.0.1", port: 1, from: "erp@cafedelnorte.test" });
    await expect(mailer.send({ to: "ana@cafe.co\r\nBcc: x@y.z", subject: "x", text: "y" })).rejects.toThrow(/invalid/);
    await expect(mailer.send({ to: "ana@cafe.co", subject: "x\r\nBcc: x@y.z", text: "y" })).rejects.toThrow(/invalid/);
  });
});
