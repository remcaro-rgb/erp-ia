// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { LinesEditor, type LineLookup } from "../LinesEditor";
import { blankLine, visibleColumns, type EditorLine, type EntrySettings } from "../entry-model";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const off: EntrySettings = { requireApprovalOnManual: false, useOpenAuxiliaries: false, useItems: false, useBusinessUnits: false };

const lookup: LineLookup = vi.fn(async (kind, search) => {
  if (kind !== "account") return [];
  return [{ id: search.startsWith("4") ? "a-ventas" : "a-caja", label: search.startsWith("4") ? "413505 · Ventas" : "110505 · Caja general" }];
});

function Harness({ settings = off, start = [blankLine()], headerBusinessUnit = null, restricted = false }: { settings?: EntrySettings; start?: EditorLine[]; headerBusinessUnit?: string | null; restricted?: boolean }) {
  const [lines, setLines] = useState(start);
  return <LinesEditor lines={lines} onChange={setLines} columns={visibleColumns(settings)} lookup={lookup} headerBusinessUnit={headerBusinessUnit} debounceMs={0} readOnly={restricted} />;
}

const cell = (name: string) => screen.getByRole(name.startsWith("Cuenta") || /^(Tercero|Centro|Auxiliar|Ítem|Unidad)/.test(name) ? "combobox" : "textbox", { name });

describe("LinesEditor", () => {
  it("Tab order skips hidden dimension columns; Enter on the last cell adds a line; the difference footer shows 0,00 when balanced", async () => {
    const user = userEvent.setup();
    renderEs(<Harness />);

    // The three optional dimensions are off: no column for them.
    expect(screen.queryByRole("columnheader", { name: /Auxiliar abierto|Ítem|Unidad de negocio/ })).toBeNull();

    // Line 1: the account is chosen from the lookup with Tab, then Tab walks tercero → centro de costo → descripción → débito (nothing in between).
    await user.click(cell("Cuenta, Línea 1"));
    await user.type(cell("Cuenta, Línea 1"), "caja");
    await screen.findByRole("option", { name: "110505 · Caja general" });
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(cell("Tercero, Línea 1"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(cell("Centro de costo, Línea 1"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(cell("Descripción, Línea 1"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(cell("Débito, Línea 1"));
    await user.keyboard("1000{Tab}");
    expect(document.activeElement).toBe(cell("Crédito, Línea 1"));
    expect((cell("Cuenta, Línea 1") as HTMLInputElement).value).toBe("110505 · Caja general");
    expect((cell("Débito, Línea 1") as HTMLInputElement).value).toBe("$ 1.000,00");

    // Enter on the last cell opens line 2 and the caret lands on its account.
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(cell("Cuenta, Línea 2"));
    await user.type(cell("Cuenta, Línea 2"), "4135");
    await screen.findByRole("option", { name: "413505 · Ventas" });
    await user.keyboard("{Tab}{Tab}{Tab}{Tab}");
    expect(document.activeElement).toBe(cell("Débito, Línea 2"));
    await user.keyboard("{Tab}1000{Tab}");

    const foot = screen.getByRole("group", { name: "Totales del comprobante" });
    expect(within(foot).getByText("$ 1.000,00", { selector: "[data-total=debit]" })).toBeTruthy();
    expect(within(foot).getByText("$ 0,00", { selector: "[data-total=difference]" })).toBeTruthy();
    expect(within(foot).getByText("Cuadrado")).toBeTruthy();
  });

  it("shows the dimension columns when the company uses them, and the header's business unit greyed until the line overrides it", () => {
    renderEs(<Harness settings={{ ...off, useBusinessUnits: true, useItems: true }} headerBusinessUnit="Sede norte" />);
    expect(screen.getByRole("columnheader", { name: "Ítem" })).toBeTruthy();
    expect((cell("Unidad de negocio, Línea 1") as HTMLInputElement).placeholder).toBe("Sede norte");
    expect(cell("Unidad de negocio, Línea 1").className).toContain("erp-lines__inherit");
  });

  it("renders a restricted line as bullets and never as its figures", () => {
    renderEs(<Harness restricted start={[{ ...blankLine(), restricted: true }, { ...blankLine(), account: { id: "a", label: "110505 · Caja" }, debit: 50 }]} />);
    expect(screen.getAllByText("••••").length).toBeGreaterThan(0);
    expect(screen.getByText("Línea de una cuenta restringida")).toBeTruthy();
  });
});

describe("LinesEditor, the empty entry (T9)", () => {
  it("shows a neutral 'Sin líneas' and not 'Cuadrado' while no line has an amount, and 'Cuadrado' once the sides match", () => {
    renderEs(<Harness />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Sin líneas");
    expect(status.className).not.toMatch(/ok/);
    cleanup();
    renderEs(<Harness start={[{ ...blankLine(), debit: 50 }, { ...blankLine(), credit: 50 }]} />);
    expect(screen.getByRole("status").textContent).toBe("Cuadrado");
  });
});
