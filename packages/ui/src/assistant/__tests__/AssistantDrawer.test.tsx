// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AssistantDrawer } from "../AssistantDrawer";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";

// The drawer end to end against a stubbed server (design §7.1, §19a, rule 17): 400 px, the conversation streams, a
// stored conversation comes back with its pending card still confirmable by id, and a step-up card asks for the code
// in the chat.

afterEach(cleanup);
stubLayoutApis();

const CONVERSATION = "0197a1b2-0000-7000-8000-0000000000c1";
const CARD = "0197a1b2-0000-7000-8000-0000000000d1";
const preview = { title: "Cambiar cupo · Café del Norte", effects: [{ label: "Cupo nuevo", value: "$ 5.000.000,00" }], permission: "core.party.update_credit", stepUp: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function sse(chunks: unknown[]) {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-workflow-run-id": "r1", "x-conversation-id": CONVERSATION } });
}

describe("AssistantDrawer", () => {
  it("is a 400 px complementary region named Asistente with the screen it looks at, and the composer", async () => {
    const fetcher = vi.fn(async () => json({ conversationId: null, messages: [], cards: {} }));
    renderEs(<AssistantDrawer open context="Terceros" screen={{ route: "/parties" }} fetcher={fetcher as unknown as typeof fetch} />);
    const drawer = screen.getByRole("complementary", { name: "Asistente" });
    expect(drawer.className).toContain("w-[400px]");
    expect(drawer.textContent).toContain("Contexto: Terceros");
    await waitFor(() => expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false));
  });

  it("is hidden but keeps the conversation when closed", async () => {
    const fetcher = vi.fn(async () => json({ conversationId: null, messages: [], cards: {} }));
    const { rerender } = renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} fetcher={fetcher as unknown as typeof fetch} />);
    expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
    rerender(<AssistantDrawer open={false} context="x" screen={{ route: "/" }} fetcher={fetcher as unknown as typeof fetch} />);
    expect(screen.queryByRole("complementary", { name: "Asistente" })).toBeNull();
  });

  it("sends the typed question with the screen and shows the streamed answer", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/agent/conversation")) return json({ conversationId: null, messages: [], cards: {} });
      return sse([{ type: "start", messageId: "m" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hay 12 clientes." }, { type: "text-end", id: "t" }, { type: "finish" }]);
    });
    renderEs(<AssistantDrawer open context="Terceros" screen={{ route: "/parties" }} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Escribe"), { target: { value: "¿cuántos clientes hay?" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByText("Hay 12 clientes.")).toBeTruthy());
    expect(screen.getByText("¿cuántos clientes hay?")).toBeTruthy();
    const turn = fetcher.mock.calls.find((c) => String(c[0]) === "/api/agent/turn") as unknown as [string, RequestInit];
    expect(JSON.parse(turn[1].body as string)).toEqual({ text: "¿cuántos clientes hay?", screen: { route: "/parties" } });
  });

  it("a question handed in by the shell (⌘K) is sent once", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith("/api/agent/conversation") ? json({ conversationId: null, messages: [], cards: {} }) : sse([{ type: "start", messageId: "m" }, { type: "finish" }])));
    const props = { open: true, context: "x", screen: { route: "/" }, fetcher: fetcher as unknown as typeof fetch };
    const { rerender } = renderEs(<AssistantDrawer {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false));
    rerender(<AssistantDrawer {...props} ask={{ text: "ventas de la semana", nonce: 1 }} />);
    await waitFor(() => expect(screen.getByText("ventas de la semana")).toBeTruthy());
    rerender(<AssistantDrawer {...props} ask={{ text: "ventas de la semana", nonce: 1 }} />);
    await waitFor(() => expect(fetcher.mock.calls.filter((c) => String(c[0]) === "/api/agent/turn")).toHaveLength(1));
  });

  it("reloading a conversation shows its pending step-up card, confirmable by card id after the code", async () => {
    const stored = {
      conversationId: CONVERSATION,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "sube el cupo de Café del Norte a 5 millones" }] },
        { id: "a1", role: "assistant", parts: [{ type: "tool-core__party__update_credit", toolCallId: "c1", state: "output-available", input: {}, output: { confirmationRequired: true, cardId: CARD, preview } }] },
      ],
      cards: { [CARD]: { status: "pending" } },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/agent/conversation")) return json(stored);
      if (url === "/api/auth/step-up") return json({ token: "tok-1" });
      if (url === "/api/agent/confirm") return json({ status: "executed", result: {} });
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    renderEs(<AssistantDrawer open context="Terceros" screen={{ route: "/parties" }} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByText("Cambiar cupo · Café del Norte")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Código de verificación"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(screen.getByText(/Listo/)).toBeTruthy());
    const call = fetcher.mock.calls.find((c) => String(c[0]) === "/api/agent/confirm") as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({ cardId: CARD, decision: "confirm", stepUpToken: "tok-1" });
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("shows an error when the stored conversation cannot be read, and stays usable", async () => {
    const fetcher = vi.fn(async () => new Response("boom", { status: 500 }));
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/No pudimos cargar tu conversación/));
    expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false);
  });

  it("follows a navigation of the assistant through the shell", async () => {
    const onNavigate = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/agent/conversation")
        ? json({ conversationId: null, messages: [], cards: {} })
        : sse([
            { type: "start", messageId: "m" },
            { type: "tool-input-available", toolCallId: "n1", toolName: "ui__open_record", input: {} },
            { type: "tool-output-available", toolCallId: "n1", output: { action: "open_record", href: "/r/core.party/0197a1b2-0000-7000-8000-0000000000aa" } },
            { type: "finish" },
          ]),
    );
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} onNavigate={onNavigate} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Escribe"), { target: { value: "abre a Café del Norte" } });
    fireEvent.keyDown(screen.getByLabelText("Escribe"), { key: "Enter" });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/r/core.party/0197a1b2-0000-7000-8000-0000000000aa"));
  });

  it("shows a refused turn as a translated message", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/agent/conversation") ? json({ conversationId: null, messages: [], cards: {} }) : json({ code: "invalid_input", details: ["message_too_long"] }, 400),
    );
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} fetcher={fetcher as unknown as typeof fetch} />);
    await waitFor(() => expect((screen.getByLabelText("Escribe") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Escribe"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/demasiado largo/i));
  });
});

describe("AssistantDrawer on small screens (UX-OD-2, T6)", () => {
  const quiet = vi.fn(async () => json({ conversationId: null, messages: [], cards: {} }));
  const mount = (onClose = vi.fn()) => {
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} onClose={onClose} fetcher={quiet as unknown as typeof fetch} />);
    return onClose;
  };

  it("has its own Cerrar control, which closes it", () => {
    const onClose = mount();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar asistente" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape inside it closes it; a dialog's Escape (the confirmation, the palette) does not reach it", () => {
    const onClose = mount();
    fireEvent.keyDown(screen.getByLabelText("Escribe"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the layout is CSS by width: a fixed overlay under 1280 px and a full-screen sheet under 768 px, safe areas and dvh included", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "..", "styles", "components.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 1279px\)\s*\{[^}]*#erp-assistant:not\(\[hidden\]\)[^}]*position: fixed/);
    const sheet = css.match(/@media \(max-width: 767px\)\s*\{[^@]*#erp-assistant:not\(\[hidden\]\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sheet).toMatch(/inset: 0|top: 0/);
    expect(sheet).toMatch(/100dvh/);
    expect(sheet).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});

describe("AssistantDrawer as a modal sheet (review T6)", () => {
  it("under 768 px the page behind is inert and the drawer is a modal dialog; wider, nothing changes", () => {
    const listeners: (() => void)[] = [];
    const mql = (matches: boolean) => ({ matches, addEventListener: (_: string, f: () => void) => listeners.push(f), removeEventListener: () => {} }) as unknown as MediaQueryList;
    document.body.insertAdjacentHTML("afterbegin", '<header data-bar></header><main id="erp-main"></main>');
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(() => mql(true));
    const quiet = vi.fn(async () => json({ conversationId: null, messages: [], cards: {} }));
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} fetcher={quiet as unknown as typeof fetch} />);
    expect(document.getElementById("erp-main")!.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Asistente" }).getAttribute("aria-modal")).toBe("true");
    cleanup();
    expect(document.getElementById("erp-main")!.hasAttribute("inert")).toBe(false);
    spy.mockImplementation(() => mql(false));
    renderEs(<AssistantDrawer open context="x" screen={{ route: "/" }} fetcher={quiet as unknown as typeof fetch} />);
    expect(document.getElementById("erp-main")!.hasAttribute("inert")).toBe(false);
    spy.mockRestore();
    document.querySelector("header[data-bar]")?.remove();
    document.getElementById("erp-main")?.remove();
  });
});
