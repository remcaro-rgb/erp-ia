// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "@erp/i18n";

// The ticket frame offers "Duplicar" (rule 37) to a caller who may open tickets, and to no one else.

const nav = vi.hoisted(() => ({ pathname: "/support", router: { push: (() => {}) as (href: string) => void } }));
vi.mock("next/navigation", () => ({ useRouter: () => nav.router, usePathname: () => nav.pathname }));
vi.mock("@/lib/support/actions", () => ({ closeTicketAction: vi.fn(), loadTicketAction: vi.fn(), replyTicketAction: vi.fn() }));
vi.mock("@/lib/records/clone", () => ({ cloneRecordAction: vi.fn() }));
vi.mock("@/lib/records/clone-handoff", () => ({ handOffClone: vi.fn() }));
vi.mock("../_components/leave-guard", () => ({ guardedNavigate: vi.fn((go: () => void) => go()) }));

const { TicketFrame, TicketView } = await import("./ticket-view");
const { loadTicketAction } = await import("@/lib/support/actions");
const { cloneRecordAction } = await import("@/lib/records/clone");
const { guardedNavigate } = await import("../_components/leave-guard");
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

describe("TicketView Duplicar (final review M-7)", () => {
  it("goes to the support screen through the shell's guarded navigation, never a bare router.push", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.pathname = "/r/support.ticket/0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const push = vi.fn();
    nav.router = { push };
    vi.mocked(loadTicketAction).mockResolvedValue({ ok: true, ticket: ticket(true) } as never);
    vi.mocked(cloneRecordAction).mockResolvedValue({ ok: true, entity: "support.ticket", sourceRowId: ticket(true).id, sourceTitle: "El NIT no valida", values: {}, carry: {}, refLabels: {} });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
          <TicketView id={ticket(true).id} />
        </NextIntlClientProvider>,
      ),
    );
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Duplicar")!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    expect(guardedNavigate).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/support");
    await act(async () => root.unmount());
    host.remove();
  });
});
