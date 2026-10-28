import { describe, expect, it } from "vitest";
import { asConfirmation, asDirective, asQueryResult, inlineOf, isInternalHref, parseRichText, processIdOfToolName, screenOf, toolCardState, userTextOf } from "../model";

// The pure side of the assistant UI: what a tool result means for the screen, which links may be followed (the model's
// output is untrusted: Task 17 prompt-injection mitigation) and how the model's text is shown.

const CARD = "0197a1b2-0000-7000-8000-000000000001";

describe("screenOf", () => {
  it("is the route without its query", () => {
    expect(screenOf("/parties?new=1")).toEqual({ route: "/parties" });
    expect(screenOf("/")).toEqual({ route: "/" });
  });
  it("names the selected record on /r/<entity>/<id>", () => {
    expect(screenOf(`/r/core.party/${CARD}`)).toEqual({ route: `/r/core.party/${CARD}`, record: { entity: "core.party", id: CARD } });
  });
  it("does not name the empty form of a new record", () => {
    expect(screenOf("/r/core.party/new")).toEqual({ route: "/r/core.party/new" });
  });
});

describe("processIdOfToolName", () => {
  it("turns a tool name back into the process id", () => {
    expect(processIdOfToolName("core__party__create")).toBe("core.party.create");
    expect(processIdOfToolName("ui__navigate")).toBe("ui.navigate");
  });
});

describe("asConfirmation", () => {
  const preview = { title: "t", effects: [{ label: "a", value: "b" }], permission: "p", stepUp: false };
  it("reads the card id and the preview, never the token", () => {
    expect(asConfirmation({ confirmationRequired: true, cardId: CARD, token: "secret", preview })).toEqual({ cardId: CARD, preview });
  });
  it("is null for anything that is not a well-formed card", () => {
    expect(asConfirmation({ confirmationRequired: true, preview })).toBeNull();
    expect(asConfirmation({ confirmationRequired: true, cardId: CARD, preview: { title: "t" } })).toBeNull();
    expect(asConfirmation({ ok: false, error: { code: "forbidden" } })).toBeNull();
    expect(asConfirmation(null)).toBeNull();
    expect(asConfirmation("confirmationRequired")).toBeNull();
  });
  it("coerces effect values to text", () => {
    const card = asConfirmation({ confirmationRequired: true, cardId: CARD, preview: { ...preview, effects: [{ label: "n", value: 5 }] } });
    expect(card?.preview.effects).toEqual([{ label: "n", value: "5" }]);
  });
});

describe("asQueryResult", () => {
  it("reads rows, total and truncated", () => {
    expect(asQueryResult({ entity: "core.party", rows: [{ id: "1", legal_name: "A" }], total: 120, page: 1, truncated: true })).toEqual({
      entity: "core.party",
      rows: [{ id: "1", legal_name: "A" }],
      total: 120,
      truncated: true,
    });
  });
  it("accepts the optional column metadata", () => {
    const result = asQueryResult({ rows: [], columns: [{ field: "balance", label: "Saldo", type: "money" }, { nope: 1 }] });
    expect(result?.columns).toEqual([{ field: "balance", label: "Saldo", type: "money" }]);
  });
  it("is null when there are no rows", () => {
    expect(asQueryResult({ ok: false })).toBeNull();
    expect(asQueryResult({ rows: "x" })).toBeNull();
  });
});

describe("isInternalHref / asDirective", () => {
  it("follows only paths of the app", () => {
    expect(isInternalHref("/parties")).toBe(true);
    expect(isInternalHref("/r/core.party/abc?x=1")).toBe(true);
    for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "/\\evil.example", "parties", "", "/a b\nc", " /x"]) {
      expect(isInternalHref(bad), bad).toBe(false);
    }
  });
  it("a directive carries a safe href or nothing", () => {
    expect(asDirective({ action: "navigate", href: "/parties" })).toEqual({ href: "/parties" });
    expect(asDirective({ action: "open_record", href: "/r/core.party/x" })).toEqual({ href: "/r/core.party/x" });
    expect(asDirective({ action: "navigate", href: "https://evil.example" })).toBeNull();
    expect(asDirective({ href: "/parties" })).toBeNull();
  });
});

describe("parseRichText (markdown-lite)", () => {
  it("splits paragraphs and bullet lists", () => {
    expect(parseRichText("Hola\n\n- uno\n- dos\n\nFin")).toEqual([
      { type: "p", children: [{ type: "text", text: "Hola" }] },
      { type: "ul", items: [[{ type: "text", text: "uno" }], [{ type: "text", text: "dos" }]] },
      { type: "p", children: [{ type: "text", text: "Fin" }] },
    ]);
  });
  it("keeps bold and code", () => {
    expect(inlineOf("a **b** `c`")).toEqual([{ type: "text", text: "a " }, { type: "strong", text: "b" }, { type: "text", text: " " }, { type: "code", text: "c" }]);
  });
  it("links only to the app's own routes; any other link is its label", () => {
    expect(inlineOf("[Terceros](/parties)")).toEqual([{ type: "link", text: "Terceros", href: "/parties" }]);
    expect(inlineOf("[x](https://evil.example)")).toEqual([{ type: "text", text: "x" }]);
    expect(inlineOf("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "x" }]);
  });
  it("never produces an image: the alt text stays", () => {
    expect(inlineOf("![logo](https://evil.example/p.png)")).toEqual([{ type: "text", text: "logo" }]);
  });
  it("raw HTML stays text", () => {
    expect(inlineOf("<img src=x onerror=alert(1)>")).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("toolCardState / userTextOf", () => {
  it("reads the state a history entry gives a card", () => {
    expect(toolCardState({ status: "executed" })).toEqual({ status: "executed" });
    expect(toolCardState({ status: "rejected", reason: "confirmation_expired" })).toEqual({ status: "rejected", reason: "confirmation_expired" });
    expect(toolCardState({ status: "pending" })).toEqual({ status: "pending" });
    expect(toolCardState({ status: "confirmed" })).toEqual({ status: "pending" });
    expect(toolCardState(undefined)).toEqual({ status: "pending" });
  });
  it("takes the text parts of the last user message", () => {
    expect(
      userTextOf([
        { role: "user", parts: [{ type: "text", text: "uno" }] },
        { role: "assistant", parts: [{ type: "text", text: "dos" }] },
        { role: "user", parts: [{ type: "text", text: "tres " }, { type: "text", text: "cuatro" }] },
      ]),
    ).toBe("tres cuatro");
  });
});
