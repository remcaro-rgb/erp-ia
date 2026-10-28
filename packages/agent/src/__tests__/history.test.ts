import { describe, expect, it } from "vitest";
import { uiMessagesFromRows } from "../runtime/history";

// A stored conversation as the drawer shows it (design §7.1): the user's text, and each assistant turn's model messages
// as one UI message with its tool parts (the same `tool-<name>` parts the live stream builds). Confirmation tokens never
// reach the page, and the model's events (decided cards) are not messages.

const CARD = "0197a1b2-0000-7000-8000-0000000000d1";
const preview = { title: "Crea un tercero", effects: [{ label: "NIT", value: "900373115" }], permission: "core.party.create", stepUp: false };

describe("uiMessagesFromRows", () => {
  it("turns user rows into user messages and an assistant row into one message with text and tool parts", () => {
    const messages = uiMessagesFromRows([
      { id: "r1", role: "user", parts: [{ type: "text", text: "crea un tercero" }] },
      {
        id: "r2",
        role: "assistant",
        parts: [
          { role: "assistant", content: [{ type: "text", text: "Te preparo la tarjeta." }, { type: "tool-call", toolCallId: "c1", toolName: "core__party__create", input: { legal_name: "X" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "core__party__create", output: { type: "json", value: { confirmationRequired: true, cardId: CARD, preview } } }] },
          { role: "assistant", content: [{ type: "text", text: "Confírmala." }] },
        ],
      },
    ]);
    expect(messages).toEqual([
      { id: "r1", role: "user", parts: [{ type: "text", text: "crea un tercero" }] },
      {
        id: "r2",
        role: "assistant",
        parts: [
          { type: "text", text: "Te preparo la tarjeta." },
          { type: "tool-core__party__create", toolCallId: "c1", state: "output-available", input: { legal_name: "X" }, output: { confirmationRequired: true, cardId: CARD, preview } },
          { type: "text", text: "Confírmala." },
        ],
      },
    ]);
  });

  it("reads a plain-string assistant content, a failed tool as an error and a call without a result as still unanswered", () => {
    const [message] = uiMessagesFromRows([
      {
        id: "r1",
        role: "assistant",
        parts: [
          { role: "assistant", content: "Hola" },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "a__b", input: {} }, { type: "tool-call", toolCallId: "c2", toolName: "a__c", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "a__b", output: { type: "error-text", value: "boom" } }] },
        ],
      },
    ]);
    expect(message!.parts).toEqual([
      { type: "text", text: "Hola" },
      { type: "tool-a__b", toolCallId: "c1", state: "output-error", input: {}, errorText: "boom" },
      { type: "tool-a__c", toolCallId: "c2", state: "input-available", input: {} },
    ]);
  });

  it("skips events and empty rows, and never carries a confirmation token", () => {
    const messages = uiMessagesFromRows([
      { id: "e1", role: "event", parts: [{ type: "confirmation", processId: "p", status: "executed" }] },
      { id: "a0", role: "assistant", parts: [] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "x__y", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "x__y", output: { type: "json", value: { confirmationRequired: true, token: "secret-token-secret-token-secret-0000", cardId: CARD, preview } } }] },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("secret-token");
  });
});
