// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "@erp/i18n";

// The ticket frame offers "Duplicar" (rule 37) to a caller who may open tickets, and to no one else.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/support" }));
vi.mock("@/lib/support/actions", () => ({ closeTicketAction: vi.fn(), loadTicketAction: vi.fn(), replyTicketAction: vi.fn() }));
vi.mock("@/lib/records/clone", () => ({ cloneRecordAction: vi.fn() }));

const { TicketFrame } = await import("./ticket-view");
type Ticket = Parameters<typeof TicketFrame>[0]["ticket"];

const ticket = (canCreate: boolean): Ticket => ({
  id: "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  seq: 3,
  kind: "bug",
  title: "El NIT no valida",
  body: "Sale un error.",
  status: "answered",
  priority: "normal",
  reporterUserId: "0192a1b2-c3d4-7e5f-8a9b-000000000001",
  createdAt: "2026-10-29T10:00:00Z",
  context: { route: "/parties" },
  extra: {},
  extraFree: [],
  defs: [],
  messages: [],
  viewerId: "0192a1b2-c3d4-7e5f-8a9b-000000000001",
  canReply: true,
  canClose: false,
  canCreate,
});

const html = (canCreate: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
      <TicketFrame ticket={ticket(canCreate)} onReply={async () => ({ ok: true, id: "x" })} onClose={async () => {}} onDuplicate={() => {}} />
    </NextIntlClientProvider>,
  );

describe("TicketFrame Duplicar", () => {
  it("shows Duplicar (with its shortcut) to a caller who may open tickets", () => {
    const markup = html(true);
    expect(markup).toContain(">Duplicar</button>");
    expect(markup).toContain('aria-keyshortcuts="Control+D Meta+D"');
  });

  it("offers no Duplicar to a caller who may not", () => {
    expect(html(false)).not.toContain("Duplicar");
  });
});
