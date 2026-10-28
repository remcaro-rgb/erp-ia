"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { asDirective, errorKeyOf, toolCardState, userTextOf, type CardState, type ScreenContext } from "./model";

// The assistant's chat state (design §7.1). AI SDK `useChat` over a `DefaultChatTransport` to POST /api/agent/turn:
// the route takes only `{ conversationId?, text, screen? }`, so `prepareSendMessagesRequest` sends the new text and the
// screen the user is looking at (never the whole history, which the server keeps), and the conversation id comes back
// in `x-conversation-id` and is reused. A stored conversation is restored from GET /api/agent/conversation with the
// state of its cards; a card is decided through POST /api/agent/confirm by its id.
//
// Reconnecting to a turn that is still running after a reload (`x-workflow-run-id`): the SDK's `WorkflowChatTransport`
// does it through GET `<api>/<runId>/stream`, an endpoint the turn route does not offer yet. The turn is durable, so
// its answer is stored: reloading shows the stored conversation (history), not the live stream of a turn in flight.

export interface UseAssistantOptions {
  screen: ScreenContext;
  /** Conversation to restore; the user's latest one when absent. */
  conversationId?: string | null;
  endpoint?: string;
  historyEndpoint?: string;
  confirmEndpoint?: string;
  /** `fetch`, injected by tests. */
  fetcher?: typeof fetch;
  /** Called once for each navigation the assistant asks for during this session (a route of the app). */
  onNavigate?: (href: string) => void;
}

interface HistoryBody {
  conversationId?: string | null;
  messages?: UIMessage[];
  cards?: Record<string, { status?: unknown; reason?: unknown }>;
}

const NAVIGATION_TOOLS = new Set(["ui__navigate", "ui__open_record"]);

export function useAssistant(options: UseAssistantOptions) {
  const { endpoint = "/api/agent/turn", historyEndpoint = "/api/agent/conversation", confirmEndpoint = "/api/agent/confirm" } = options;
  const [conversationId, setConversationId] = useState<string | null>(options.conversationId ?? null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [ready, setReady] = useState(false);
  /** The stored conversation could not be read: said, instead of silently starting a new one. */
  const [historyFailed, setHistoryFailed] = useState(false);

  // The transport and the callbacks read the latest values from refs: the chat is created once.
  const latest = useRef({ screen: options.screen, fetcher: options.fetcher, onNavigate: options.onNavigate });
  const conversationRef = useRef<string | null>(conversationId);
  useEffect(() => {
    latest.current = { screen: options.screen, fetcher: options.fetcher, onNavigate: options.onNavigate };
  });
  const remember = useCallback((id: string | null) => {
    conversationRef.current = id;
    setConversationId(id);
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: endpoint,
        fetch: async (input, init) => {
          const response = await (latest.current.fetcher ?? fetch)(input, init);
          const id = response.headers.get("x-conversation-id");
          if (id) remember(id);
          return response;
        },
        prepareSendMessagesRequest: ({ messages }) => {
          const { screen } = latest.current;
          const conversation = conversationRef.current;
          return { body: { ...(conversation ? { conversationId: conversation } : {}), text: userTextOf(messages), ...(screen.route || screen.record ? { screen } : {}) } };
        },
      }),
    [endpoint, remember],
  );

  const { messages, status, error, sendMessage, setMessages, stop, clearError } = useChat<UIMessage>({ transport });

  // Navigations already followed (or restored from the history, which are never followed again).
  const handled = useRef(new Set<string>());
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available" || !NAVIGATION_TOOLS.has(getToolName(part))) continue;
        if (handled.current.has(part.toolCallId)) continue;
        handled.current.add(part.toolCallId);
        const directive = asDirective(part.output);
        if (directive) latest.current.onNavigate?.(directive.href);
      }
    }
  }, [messages]);

  // Restore the stored conversation.
  const wanted = options.conversationId ?? null;
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setHistoryFailed(false);
    (async () => {
      try {
        const url = wanted ? `${historyEndpoint}?id=${encodeURIComponent(wanted)}` : historyEndpoint;
        const response = await (latest.current.fetcher ?? fetch)(url, { signal: controller.signal });
        if (!response.ok) {
          setHistoryFailed(true);
          return remember(null);
        }
        const body = (await response.json()) as HistoryBody;
        const restored = Array.isArray(body.messages) ? body.messages : [];
        for (const message of restored) for (const part of message.parts) if (isToolUIPart(part)) handled.current.add(part.toolCallId);
        setMessages(restored);
        setCards(Object.fromEntries(Object.entries(body.cards ?? {}).map(([id, stored]) => [id, toolCardState(stored)])));
        remember(typeof body.conversationId === "string" ? body.conversationId : null);
      } catch {
        if (!controller.signal.aborted) {
          setHistoryFailed(true);
          remember(null);
        }
      } finally {
        if (!controller.signal.aborted) setReady(true);
      }
    })();
    return () => controller.abort();
  }, [wanted, historyEndpoint, remember, setMessages]);

  const chatErrorKey = error ? errorKeyOf(error) : null;
  const errorKey = chatErrorKey ?? (historyFailed ? "agent.ui.errors.history_failed" : null);
  useEffect(() => {
    // A conversation that is gone (deleted, other company): the next question starts a new one.
    if (chatErrorKey === "agent.ui.errors.conversation_not_found") remember(null);
  }, [chatErrorKey, remember]);

  const send = useCallback(
    (text: string) => {
      setHistoryFailed(false);
      return sendMessage({ text });
    },
    [sendMessage],
  );

  const decide = useCallback(
    async (cardId: string, decision: "confirm" | "reject", stepUpToken?: string) => {
      setCards((c) => ({ ...c, [cardId]: { status: "confirming" } }));
      try {
        const response = await (latest.current.fetcher ?? fetch)(confirmEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cardId, decision, ...(stepUpToken ? { stepUpToken } : {}) }),
        });
        const body = (await response.json().catch(() => null)) as { status?: string; reason?: string; code?: string; details?: unknown } | null;
        if (response.ok && body && (body.status === "executed" || body.status === "rejected")) {
          return setCards((c) => ({ ...c, [cardId]: toolCardState(body) }));
        }
        // The card expired while it waited: it ended rejected on the server.
        if (Array.isArray(body?.details) && body.details[0] === "confirmation_expired") {
          return setCards((c) => ({ ...c, [cardId]: { status: "rejected", reason: "confirmation_expired" } }));
        }
        setCards((c) => ({ ...c, [cardId]: { status: "pending", error: body?.code ?? "unknown" } }));
      } catch {
        setCards((c) => ({ ...c, [cardId]: { status: "pending", error: "network" } }));
      }
    },
    [confirmEndpoint],
  );

  /** A change to a card's values: the card is discarded and the change goes back to the assistant as a new message. */
  const editCard = useCallback(
    async (cardId: string, text: string) => {
      await decide(cardId, "reject");
      await sendMessage({ text });
    },
    [decide, sendMessage],
  );

  const newConversation = useCallback(() => {
    void stop();
    clearError();
    setHistoryFailed(false);
    setMessages([]);
    setCards({});
    remember(null);
  }, [stop, clearError, setMessages, remember]);

  return {
    messages,
    status,
    working: status === "submitted" || status === "streaming",
    errorKey,
    conversationId,
    /** The stored conversation has been looked up (the composer waits for it). */
    ready,
    cards,
    send,
    stop,
    decide,
    editCard,
    newConversation,
  };
}

export type AssistantState = ReturnType<typeof useAssistant>;
