// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { useAskAssistant } from "../ask-assistant";
import { memoryStorage, renderEs, stubLayoutApis } from "./intl";

// Screens inside the shell hand the assistant a message (the home screen's accepted recommendation opens it with
// "Ejecuta <proceso> con <input>"): useAskAssistant() opens the drawer if it is closed and sends the text as the user.

beforeAll(stubLayoutApis);
// The drawer starts open from 1280 px (OD-10); jsdom's default window is 1024.
beforeEach(() => {
  window.innerWidth = 1440;
});
afterEach(cleanup);

function AskButton({ text }: { text: string }) {
  const ask = useAskAssistant();
  return <button onClick={() => ask(text)}>preguntar</button>;
}

const cafe = { id: "c1", name: "Café del Norte S.A.S." };

describe("useAskAssistant", () => {
  it("opens the closed drawer and sends the text as the user's message", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/agent/conversation")
        ? new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 })
        : new Response('data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n', { status: 200, headers: { "x-conversation-id": "0197a1b2-0000-7000-8000-0000000000c1" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      renderEs(
        <AppShell company={cafe} companies={[cafe]} user={{ id: "u1", name: "Laura", email: "l@x.co", roles: [] }} modules={[]} nav={[]} currentHref="/" navigate={vi.fn()} storage={memoryStorage()}>
          <AskButton text='Ejecuta core.party.create con {"legal_name":"Panadería La Espiga"}' />
        </AppShell>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Asistente" }));
      expect(screen.queryByRole("complementary", { name: "Asistente" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "preguntar" }));
      const drawer = screen.getByRole("complementary", { name: "Asistente" });
      await waitFor(() => expect(drawer.textContent).toContain("Ejecuta core.party.create"));
      const turn = fetcher.mock.calls.find((c) => String(c[0]) === "/api/agent/turn") as unknown as [string, RequestInit];
      expect(JSON.parse(turn[1].body as string).text).toBe('Ejecuta core.party.create con {"legal_name":"Panadería La Espiga"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does nothing outside the shell", () => {
    renderEs(<AskButton text="hola" />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "preguntar" }))).not.toThrow();
  });
});
