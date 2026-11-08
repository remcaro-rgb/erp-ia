// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { ReceiptForm, type OpenInvoice } from "../PaymentForms";
import { AdvanceApplyPanel } from "../AdvanceApplyPanel";

afterEach(cleanup);
stubLayoutApis();

// Owner's text of 2026-11-06 (item 23): «Registrar pago» says, once, under the invoices, that an invoice the DIAN has not accepted yet can
// be paid as an advance and applied later. The apply panel caps each line by what is left of the advance.

const HINT = "Esta factura aún no ha sido aceptada por la DIAN; puede registrar el dinero como anticipo y aplicarlo después.";
const invoice = (id: string, extra: Partial<OpenInvoice> = {}): OpenInvoice => ({ id, number: `FE-${id}`, issueDate: "2026-11-01", dueDate: null, currency: "COP", total: 500000, open: 500000, payable: true, reasonCode: null, reason: null, ...extra });
const notAccepted = (id: string) => invoice(id, { payable: false, reasonCode: "invoice_not_accepted", reason: "La DIAN aún no ha aceptado la factura" });

function form(invoices: OpenInvoice[]) {
  return renderEs(
    <ReceiptForm
      today="2026-11-07"
      methods={[]}
      cashBoxes={[]}
      party={{ fields: [], entityLabel: "Tercero" }}
      initial={{ party_id: "party-1" }}
      labels={{ party_id: "Cliente Uno" }}
      loadInvoices={async () => ({ ok: true, invoices })}
      process="payments.payment.receive"
      save={async () => ({ ok: false, code: "x", messages: [] }) as never}
    />,
  );
}

describe("the advance hint on «Registrar pago»", () => {
  it("renders the owner's text once when a listed invoice is not accepted yet", async () => {
    form([notAccepted("1"), notAccepted("2"), invoice("3")]);
    await waitFor(() => expect(screen.getAllByText(HINT)).toHaveLength(1));
  });

  it("does not render when every listed invoice can be paid or fails for another reason", async () => {
    form([invoice("1"), invoice("2", { payable: false, reasonCode: "invoice_voided", reason: "La factura está anulada" })]);
    await waitFor(() => expect(screen.getByRole("table", { name: "Facturas del cliente" })).toBeTruthy());
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

describe("the apply panel", () => {
  it("caps each line by what is left of the advance: «Máximo» fills the cap and the confirm waits for a valid total", async () => {
    const calls: unknown[] = [];
    renderEs(
      <AdvanceApplyPanel
        partyId="party-1"
        receiptId="receipt-1"
        remaining={350000}
        today="2026-11-07"
        loadInvoices={async () => ({ ok: true, invoices: [invoice("1", { open: 300000 }), invoice("2", { open: 400000 }), notAccepted("3")] })}
        apply={async (input) => {
          calls.push(input);
          return { ok: true };
        }}
        onApplied={() => {}}
        onCancel={() => {}}
      />,
    );
    const table = await screen.findByRole("table", { name: "Facturas del cliente" });
    expect(table).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Aplicar anticipo" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    screen.getAllByRole("button", { name: "Máximo" })[0]!.click();
    await waitFor(() => expect((screen.getByLabelText("Aplicar a FE-1") as HTMLInputElement).value).toBe("300000"));
    screen.getAllByRole("button", { name: "Máximo" })[1]!.click();
    // the second line takes only what the first left of the advance: 350.000 - 300.000
    await waitFor(() => expect((screen.getByLabelText("Aplicar a FE-2") as HTMLInputElement).value).toBe("50000"));
    expect(screen.queryByLabelText("Aplicar a FE-3")).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "Aplicar anticipo" }) as HTMLButtonElement).disabled).toBe(false));
    screen.getByRole("button", { name: "Aplicar anticipo" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ partyId: "party-1", lines: [{ receiptId: "receipt-1", invoiceId: "1", amount: 300000 }, { receiptId: "receipt-1", invoiceId: "2", amount: 50000 }] });
  });
});
