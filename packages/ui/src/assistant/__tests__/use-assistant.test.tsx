// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useAssistant, type UseAssistantOptions } from "../use-assistant";

// The assistant hook (design §7.1): AI SDK `useChat` against POST /api/agent/turn. Every turn carries the screen the
// user is looking at; the conversation id comes back in a header and is reused; a stored conversation is restored with
// its cards; a card is decided through POST /api/agent/confirm by its id.

afterEach(cleanup);

const CONVERSATION = "0197a1b2-0000-7000-8000-0000000000c1";
const CARD = "0197a1b2-0000-7000-8000-0000000000d1";

/** A server-sent stream of UI message chunks, as POST /api/agent/turn answers. */
function sse(chunks: unknown[], headers: Record<string, string> = {}): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-workflow-run-id": "run-1", "x-conversation-id": CONVERSATION, ...headers } });
}
const answer = (text: string): unknown[] => [
  { type: "start", messageId: crypto.randomUUID() },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish" },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; init?: RequestInit };
function server(handlers: { history?: () => Response; turn?: (body: Record<string, unknown>) => Response; confirm?: (body: Record<string, unknown>) => Response }) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.startsWith("/api/agent/conversation")) return handlers.history ? handlers.history() : json({ conversationId: null, messages: [], cards: {} });
    if (url === "/api/agent/turn") return handlers.turn ? handlers.turn(body) : sse(answer("ok"));
    if (url === "/api/agent/confirm") return handlers.confirm ? handlers.confirm(body) : json({ status: "executed" });
    return new Response("not found", { status: 404 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls, turns: () => calls.filter((c) => c.url === "/api/agent/turn").map((c) => JSON.parse(c.init!.body as string) as Record<string, unknown>) };
}

const setup = (options: Partial<UseAssistantOptions> & Pick<UseAssistantOptions, "fetcher">) => renderHook((props: Partial<UseAssistantOptions>) => useAssistant({ screen: { route: "/parties" }, ...options, ...props }), { initialProps: {} });

describe("useAssistant", () => {
  it("sends the text with screen.route on every turn, and the conversation id the first answer gave", async () => {
    const s = server({});
    const { result, rerender } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => void result.current.send("¿cuántos clientes hay?"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(s.turns()[0]).toEqual({ text: "¿cuántos clientes hay?", screen: { route: "/parties" } });
    expect(result.current.conversationId).toBe(CONVERSATION);

    rerender({ screen: { route: "/r/core.party/0197a1b2-0000-7000-8000-0000000000aa", record: { entity: "core.party", id: "0197a1b2-0000-7000-8000-0000000000aa" } } });
    await act(async () => void result.current.send("¿y su saldo?"));
    await waitFor(() => expect(s.turns()).toHaveLength(2));
    expect(s.turns()[1]).toEqual({
      conversationId: CONVERSATION,
      text: "¿y su saldo?",
      screen: { route: "/r/core.party/0197a1b2-0000-7000-8000-0000000000aa", record: { entity: "core.party", id: "0197a1b2-0000-7000-8000-0000000000aa" } },
    });
  });

  it("sends only the new text, never the whole history (the route caps the body)", async () => {
    const s = server({});
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.send("uno"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => void result.current.send("dos"));
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(Object.keys(s.turns()[1]!).sort()).toEqual(["conversationId", "screen", "text"]);
    expect(result.current.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("streams the answer into message parts", async () => {
    const s = server({ turn: () => sse(answer("Hay 12 clientes.")) });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.send("clientes"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const last = result.current.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.parts.find((p) => p.type === "text")).toMatchObject({ text: "Hay 12 clientes." });
  });

  it("restores the stored conversation with the state of its cards", async () => {
    const stored = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "crea un tercero" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Confirma" }] },
    ];
    const s = server({ history: () => json({ conversationId: CONVERSATION, messages: stored, cards: { [CARD]: { status: "rejected", reason: "confirmation_expired" } } }) });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.conversationId).toBe(CONVERSATION);
    expect(result.current.cards[CARD]).toEqual({ status: "rejected", reason: "confirmation_expired" });
    // The next turn continues that conversation.
    await act(async () => void result.current.send("sigue"));
    await waitFor(() => expect(s.turns()).toHaveLength(1));
    expect(s.turns()[0]).toMatchObject({ conversationId: CONVERSATION, text: "sigue" });
  });

  it("starts empty when there is no stored conversation or the history cannot be read", async () => {
    const s = server({ history: () => new Response("boom", { status: 500 }) });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversationId).toBeNull();
  });

  it("confirms a card by its id with the step-up token, and keeps the final state", async () => {
    const s = server({ confirm: () => json({ status: "executed", result: { id: "x" } }) });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.decide(CARD, "confirm", "tok"));
    const call = s.calls.find((c) => c.url === "/api/agent/confirm")!;
    expect(JSON.parse(call.init!.body as string)).toEqual({ cardId: CARD, decision: "confirm", stepUpToken: "tok" });
    expect(result.current.cards[CARD]).toEqual({ status: "executed" });
  });

  it("a rejected card keeps its reason; a refusal leaves it confirmable with the code", async () => {
    let next: Response = json({ status: "rejected", reason: "confirmation_expired" });
    const s = server({ confirm: () => next });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.decide(CARD, "reject"));
    expect(result.current.cards[CARD]).toEqual({ status: "rejected", reason: "confirmation_expired" });

    next = json({ code: "step_up_required", details: null }, 401);
    await act(async () => void result.current.decide("0197a1b2-0000-7000-8000-0000000000d2", "confirm"));
    expect(result.current.cards["0197a1b2-0000-7000-8000-0000000000d2"]).toEqual({ status: "pending", error: "step_up_required" });

    next = json({ code: "invalid_input", details: ["confirmation_expired"] }, 400);
    await act(async () => void result.current.decide("0197a1b2-0000-7000-8000-0000000000d3", "confirm"));
    expect(result.current.cards["0197a1b2-0000-7000-8000-0000000000d3"]).toEqual({ status: "rejected", reason: "confirmation_expired" });
  });

  it("editing a card rejects it and sends the change as a new user message", async () => {
    const s = server({});
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.editCard(CARD, "Cambia Ciudad a Medellín"));
    await waitFor(() => expect(s.turns()).toHaveLength(1));
    expect(s.turns()[0]).toMatchObject({ text: "Cambia Ciudad a Medellín" });
    const confirm = s.calls.find((c) => c.url === "/api/agent/confirm")!;
    expect(JSON.parse(confirm.init!.body as string)).toEqual({ cardId: CARD, decision: "reject" });
  });

  it("follows a navigation directive of a tool result once, but not one restored from the history", async () => {
    const chunks = [
      { type: "start", messageId: "m1" },
      { type: "tool-input-available", toolCallId: "c1", toolName: "ui__navigate", input: { href: "/parties" } },
      { type: "tool-output-available", toolCallId: "c1", output: { action: "navigate", href: "/parties" } },
      { type: "tool-input-available", toolCallId: "c2", toolName: "ui__navigate", input: { href: "https://evil.example" } },
      { type: "tool-output-available", toolCallId: "c2", output: { action: "navigate", href: "https://evil.example" } },
      { type: "finish" },
    ];
    const onNavigate = vi.fn();
    const s = server({ turn: () => sse(chunks) });
    const { result } = setup({ fetcher: s.fetcher, onNavigate });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.send("llévame a terceros"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/parties");

    const restored = vi.fn();
    const history = {
      conversationId: CONVERSATION,
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "tool-ui__navigate", toolCallId: "old", state: "output-available", input: { href: "/products" }, output: { action: "navigate", href: "/products" } }] }],
      cards: {},
    };
    const s2 = server({ history: () => json(history) });
    const second = setup({ fetcher: s2.fetcher, onNavigate: restored });
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(restored).not.toHaveBeenCalled();
  });

  it("turns a refused turn into an error code the drawer can translate", async () => {
    const s = server({ turn: () => json({ code: "invalid_input", details: ["message_too_long"] }, 400) });
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.send("x"));
    await waitFor(() => expect(result.current.errorKey).toBe("agent.ui.errors.message_too_long"));
  });

  it("a conversation that is no longer there starts over on the next turn", async () => {
    const s = server({ history: () => json({ conversationId: CONVERSATION, messages: [], cards: {} }), turn: () => json({ code: "not_found", details: ["conversation_not_found"] }, 404) });
    const { result } = setup({ fetcher: s.fetcher, conversationId: CONVERSATION });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.conversationId).toBe(CONVERSATION);
    await act(async () => void result.current.send("hola"));
    await waitFor(() => expect(result.current.errorKey).toBe("agent.ui.errors.conversation_not_found"));
    expect(result.current.conversationId).toBeNull();
  });

  it("newConversation clears the messages and the conversation id", async () => {
    const s = server({});
    const { result } = setup({ fetcher: s.fetcher });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => void result.current.send("uno"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.newConversation());
    expect(result.current.messages).toEqual([]);
    expect(result.current.conversationId).toBeNull();
    await act(async () => void result.current.send("dos"));
    await waitFor(() => expect(s.turns()).toHaveLength(2));
    expect(s.turns()[1]).not.toHaveProperty("conversationId");
  });
});
