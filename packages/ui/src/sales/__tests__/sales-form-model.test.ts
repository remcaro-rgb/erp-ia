import { describe, expect, it } from "vitest";
import {
  activityInput,
  activityMissing,
  activityDraft,
  convertDraft,
  convertInput,
  fulfilDraft,
  fulfilInput,
  fulfilMissing,
  leadDraft,
  leadInput,
  leadMissing,
  opportunityDraft,
  opportunityInput,
  opportunityMissing,
  pipelineDraft,
  pipelineInput,
  pipelineMissing,
  saleDraft,
  saleInput,
  saleMissing,
} from "../sales-form-model";

const line = (over: Partial<ReturnType<typeof saleDraft>["lines"][number]> = {}) => ({ ...saleDraft("2026-11-05", null).lines[0]!, ...over });

describe("cotización and pedido drafts", () => {
  it("a new one starts today with one empty line and misses the customer and the lines", () => {
    const draft = saleDraft("2026-11-05", null);
    expect(draft.issueDate).toBe("2026-11-05");
    expect(draft.lines).toHaveLength(1);
    expect(saleMissing(draft)).toEqual(["party", "lines"]);
  });

  it("a stored one keeps its lines (prices as numbers, a zero discount left empty) and ends with an empty line", () => {
    const draft = saleDraft("2026-11-05", { party_id: "p1", issue_date: new Date("2026-11-01T00:00:00Z"), valid_until: "2026-12-01", notes: "N" }, [
      { product_id: "x", product_label: "SKU · Café", qty: "3.0000", unit_price: "28000.0000", discount_pct: "0.0000", description: null },
    ], { party_id: "Distribuidora" });
    expect(draft.partyLabel).toBe("Distribuidora");
    expect(draft.issueDate).toBe("2026-11-01");
    expect(draft.lines[0]).toMatchObject({ productId: "x", productLabel: "SKU · Café", qty: "3", unitPrice: "28000", discountPct: "" });
    expect(draft.lines).toHaveLength(2);
  });

  it("sends a price or a discount only when typed; the empty trailing line is not sent", () => {
    const draft = { ...saleDraft("2026-11-05", null), partyId: "p1", lines: [line({ productId: "a", qty: "2" }), line({ productId: "b", qty: "1,5", unitPrice: "1.000,50", discountPct: "15" }), line()] };
    expect(saleMissing(draft)).toEqual([]);
    expect(saleInput("quote", draft, null)).toEqual({ partyId: "p1", issueDate: "2026-11-05", lines: [{ productId: "a", qty: 2 }, { productId: "b", qty: 1.5, unitPrice: 1000.5, discountPct: 15 }] });
  });

  it("an order sends its bodega and delivery date; an update clears what was emptied", () => {
    const draft = { ...saleDraft("2026-11-05", null), partyId: "p1", warehouseId: "w1", deliveryDate: "2026-11-10", lines: [line({ productId: "a", qty: "1" })] };
    expect(saleInput("order", draft, null)).toMatchObject({ partyId: "p1", warehouseId: "w1", deliveryDate: "2026-11-10" });
    expect(saleInput("order", { ...draft, warehouseId: "", deliveryDate: "" }, "o1")).toEqual({ id: "o1", lines: [{ productId: "a", qty: 1 }], deliveryDate: null, warehouseId: null, notes: null });
    expect(saleInput("quote", draft, "q1")).toEqual({ id: "q1", lines: [{ productId: "a", qty: 1 }], notes: null });
  });

  it("rule 14: an update by a restricted role sends only what changed and never a field it sees masked (it would clear it)", () => {
    // A salesperson who sees the notes and the line prices masked: the stored record comes with the masked values.
    const stored = { party_id: "p1", issue_date: "2026-11-01", valid_until: "2026-12-01", delivery_date: "2026-11-10", warehouse_id: null, notes: null };
    const lines = [{ product_id: "x", product_label: "Café", qty: "3", unit_price: null, discount_pct: null, description: null }];
    const initial = saleDraft("2026-11-05", stored, lines);
    const masked = new Set(["notes", "warehouse_id"]);
    // Only the validity changed: no notes (masked), no lines (unchanged, their prices masked).
    expect(saleInput("quote", { ...initial, validUntil: "2026-12-15" }, "q1", { initial, masked })).toEqual({ id: "q1", validUntil: "2026-12-15" });
    // An order: the delivery date cleared is sent as null; the masked bodega is never sent, even emptied.
    expect(saleInput("order", { ...initial, deliveryDate: "", warehouseId: "" }, "o1", { initial, masked })).toEqual({ id: "o1", deliveryDate: null });
    // A changed line sends the lines.
    const changed = { ...initial, lines: initial.lines.map((l, i) => (i === 0 ? { ...l, qty: "4" } : l)) };
    expect(saleInput("order", changed, "o1", { initial, masked })).toEqual({ id: "o1", lines: [{ productId: "x", qty: 4 }] });
  });

  it("an invoice (plan 2B Task 20) sends its payment form, payment means and due date; an update of one from pedidos never sends lines", () => {
    const draft = { ...saleDraft("2026-11-05", null), partyId: "p1", paymentForm: "2", paymentMeans: "42", dueDate: "2026-12-05", lines: [line({ productId: "a", qty: "1" })] };
    expect(saleInput("invoice", draft, null)).toEqual({ partyId: "p1", issueDate: "2026-11-05", dueDate: "2026-12-05", paymentForm: "2", paymentMeans: "42", lines: [{ productId: "a", qty: 1 }] });
    const stored = saleDraft("2026-11-05", { party_id: "p1", issue_date: "2026-11-01", due_date: "2026-12-01", payment_form: "2", payment_means: "42", notes: null }, [
      { product_id: "a", product_label: "Café", qty: "3", unit_price: "28000", discount_pct: "0" },
    ]);
    expect(stored).toMatchObject({ paymentForm: "2", paymentMeans: "42", dueDate: "2026-12-01" });
    const changed = { ...stored, paymentMeans: "10", lines: stored.lines.map((l, i) => (i === 0 ? { ...l, qty: "4" } : l)) };
    expect(saleInput("invoice", changed, "i1", { initial: stored })).toEqual({ id: "i1", paymentMeans: "10", lines: [{ productId: "a", qty: 4, unitPrice: 28000 }] });
    // An invoice of pedidos bills what shipped: its lines are not the form's to send.
    expect(saleInput("invoice", changed, "i1", { initial: stored, linesLocked: true })).toEqual({ id: "i1", paymentMeans: "10" });
  });

  it("refuses a quantity that is not positive and a discount above 100", () => {
    const base = { ...saleDraft("2026-11-05", null), partyId: "p1" };
    expect(saleMissing({ ...base, lines: [line({ productId: "a", qty: "0" })] })).toEqual(["qty"]);
    expect(saleMissing({ ...base, lines: [line({ productId: "a", qty: "1", discountPct: "120" })] })).toEqual(["discount"]);
  });
});

describe("entrega and devolución drafts", () => {
  it("sends no lines when none is typed (everything left), only the typed ones otherwise", () => {
    const draft = { ...fulfilDraft("2026-11-05"), sourceId: "o1", lines: [{ lineId: "l1", lineNo: 1, label: "A", sourceQty: 3, qty: "" }, { lineId: "l2", lineNo: 2, label: "B", sourceQty: 2, qty: "1" }] };
    expect(fulfilInput("delivery", { ...draft, lines: draft.lines.map((l) => ({ ...l, qty: "" })) })).toEqual({ orderId: "o1", date: "2026-11-05" });
    expect(fulfilInput("delivery", draft)).toEqual({ orderId: "o1", date: "2026-11-05", lines: [{ orderLineId: "l2", qty: 1 }] });
    expect(fulfilInput("return", { ...draft, reason: " Dañado " })).toEqual({ deliveryId: "o1", reason: "Dañado", date: "2026-11-05", lines: [{ deliveryLineId: "l2", qty: 1 }] });
  });

  it("a devolución needs its reason; a quantity above the source line is refused", () => {
    const draft = { ...fulfilDraft("2026-11-05"), sourceId: "d1", lines: [{ lineId: "l1", lineNo: 1, label: "A", sourceQty: 3, qty: "4" }] };
    expect(fulfilMissing("return", draft)).toEqual(["reason", "qty"]);
    expect(fulfilMissing("delivery", { ...fulfilDraft("2026-11-05") })).toEqual(["order"]);
  });
});

describe("prospecto", () => {
  it("needs a name, and the phone with its country code", () => {
    expect(leadMissing(leadDraft(null))).toEqual(["name"]);
    expect(leadMissing({ ...leadDraft(null), name: "X", phone: "3001234567" })).toEqual(["phone"]);
  });

  it("creates without a stage and updates the manual ones only", () => {
    const draft = { ...leadDraft(null), name: " Tostadores ", contactName: "Marta" };
    expect(leadInput(draft, null)).toEqual({ name: "Tostadores", contactName: "Marta", source: "other", isActive: true });
    expect(leadInput({ ...draft, stage: "qualified" }, "l1")).toMatchObject({ id: "l1", stage: "qualified" });
    expect(leadInput({ ...draft, stage: "converted" }, "l1")).not.toHaveProperty("stage");
  });

  it("convert sends the document data and the oportunidad, a natural person's names only for one", () => {
    const draft = { ...convertDraft({ name: "Tostadores" }), personType: "1", documentType: "31", documentNumber: "901234567", firstName: "Ana", amount: "1.500.000" };
    expect(convertInput("l1", draft)).toEqual({ id: "l1", personType: "1", documentType: "31", documentNumber: "901234567", opportunityTitle: "Tostadores", amount: 1500000 });
    expect(convertInput("l1", { ...draft, personType: "2", firstSurname: "Rojas" })).toMatchObject({ firstName: "Ana", firstSurname: "Rojas" });
  });
});

describe("embudo", () => {
  it("a new one starts with the standard etapas; it needs code, name and a won and a lost etapa", () => {
    const draft = pipelineDraft(null);
    expect(draft.stages.map((st) => st.kind)).toEqual(["open", "open", "open", "open", "won", "lost"]);
    expect(pipelineMissing(draft)).toEqual(["code", "name"]);
    expect(pipelineMissing({ ...draft, code: "V", name: "Ventas", stages: draft.stages.filter((st) => st.kind !== "lost") })).toEqual(["stages"]);
  });

  it("an update names the kept etapas by id and never sends the default flag", () => {
    const draft = pipelineDraft({ code: "V", name: "Ventas", is_default: true }, [{ id: "s2", line_no: 2, name: "B", probability: "50", kind: "open" }, { id: "s1", line_no: 1, name: "A", probability: "10", kind: "open" }]);
    const input = pipelineInput(draft, "p1");
    expect(input).not.toHaveProperty("isDefault");
    expect(input.stages).toEqual([{ id: "s1", name: "A", probability: 10, kind: "open" }, { id: "s2", name: "B", probability: 50, kind: "open" }]);
  });
});

describe("oportunidad and actividad", () => {
  it("an oportunidad is with a customer or a prospecto; its lines are a product or a description", () => {
    const draft = opportunityDraft();
    expect(opportunityMissing(draft)).toEqual(["title", "party_or_lead"]);
    const full = { ...draft, title: "Pedido mensual", partyId: "p1", amount: "1000", lines: [{ ...draft.lines[0]!, description: "Asesoría", qty: "2", unitPrice: "500" }] };
    expect(opportunityMissing(full)).toEqual([]);
    expect(opportunityInput(full)).toEqual({ title: "Pedido mensual", partyId: "p1", amount: 1000, lines: [{ description: "Asesoría", qty: 2, unitPrice: 500 }] });
  });

  it("an actividad is about something and sends its due day at noon UTC", () => {
    const draft = activityDraft();
    expect(activityMissing(draft)).toEqual(["subject", "about"]);
    expect(activityInput({ ...draft, subject: "Llamar", leadId: "l1", dueDate: "2026-11-10" })).toEqual({ kind: "call", subject: "Llamar", leadId: "l1", dueAt: "2026-11-10T12:00:00Z", done: false });
  });
});
