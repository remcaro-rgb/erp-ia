// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RecordFrame, recordHref, recordTabIds, shortId, type RecordTab } from "../../index";

afterEach(cleanup);

const id = "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const tab = (tabId: RecordTab["id"], extra: Partial<RecordTab> = {}): RecordTab => ({ id: tabId, content: <p>contenido {tabId}</p>, ...extra });

const party = (
  <RecordFrame
    title="Supermercados Éxito"
    seq={7}
    uuid={id}
    deepLinkHref={recordHref("core.party", id)}
    tabs={[tab("datos"), tab("contactos", { count: 2 }), tab("fotos"), tab("extra", { count: 3, warn: 1 }), tab("archivos", { warn: 2 })]}
    status={<span>Estado DIAN: completo</span>}
    footer={<button type="button">Guardar</button>}
  />
);

describe("RecordFrame", () => {
  it("renders the five tabs for a party and the open-in-new-tab link /r/core.party/<id>", () => {
    render(party);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["datos", "contactos", "fotos", "extra", "archivos"]);
    expect(screen.getByRole("tab", { name: /^Datos$/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Contactos/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Fotos$/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Datos adicionales/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Archivos/ })).toBeTruthy();

    const link = screen.getByRole("link", { name: /Abrir en una pestaña nueva/ });
    expect(link.getAttribute("href")).toBe(`/r/core.party/${id}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows the title, N.º and the short UUID, and the status and actions in the footer", () => {
    render(party);
    expect(screen.getByRole("heading", { name: "Supermercados Éxito" })).toBeTruthy();
    expect(screen.getByText(`N.º 7 · uuid ${shortId(id)}…`)).toBeTruthy();
    expect(shortId(id)).toBe("0192a1b2");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Estado DIAN: completo")).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Guardar" })).toBeTruthy();
  });

  it("says the number and uuid are assigned on create while the record is new, and offers no deep link", () => {
    render(<RecordFrame title="Nuevo tercero" tabs={[tab("datos")]} />);
    expect(screen.getByText("N.º y uuid se asignan al crear")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders only the tabs it is given and starts on the first", () => {
    render(<RecordFrame title="Categoría" seq={1} uuid={id} tabs={[tab("datos"), tab("extra"), tab("archivos")]} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: /Contactos/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Datos$/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("switches tabs, keeping every panel mounted so a half-filled form survives", () => {
    render(party);
    expect(screen.getByText("contenido datos").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(false);
    expect(screen.getByText("contenido extra").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /^Datos adicionales/ }));
    expect(screen.getByText("contenido extra").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(false);
    expect(screen.getByText("contenido datos").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
    expect(screen.getByRole("tab", { name: /^Datos adicionales/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("moves between tabs with the arrow keys", () => {
    render(party);
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Datos$/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /^Contactos/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Contactos/ }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Datos$/ }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /^Archivos/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows the count and the pending badge of a tab", () => {
    render(party);
    const extra = screen.getByRole("tab", { name: /^Datos adicionales/ });
    expect(within(extra).getByText("3")).toBeTruthy();
    expect(within(extra).getByTitle("Pendientes").textContent).toBe("1");
    expect(within(screen.getByRole("tab", { name: /^Archivos/ })).getByTitle("Pendientes").textContent).toBe("2");
  });

  it("takes the copy and the tab names from props", () => {
    render(<RecordFrame title="Party" seq={1} uuid={id} deepLinkHref="/r/core.party/x" tabs={[tab("datos", { label: "Data" })]} labels={{ openInNewTab: "Open in a new tab" }} />);
    expect(screen.getByRole("tab", { name: "Data" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open in a new tab/ })).toBeTruthy();
  });
});

describe("record model", () => {
  it("builds the deep link from the entity id and the record id", () => {
    expect(recordHref("core.product", id)).toBe(`/r/core.product/${id}`);
  });

  it("parties show Contactos, products show Fotos, every record shows Datos adicionales and Archivos", () => {
    expect(recordTabIds("core.party")).toEqual(["datos", "contactos", "extra", "archivos"]);
    expect(recordTabIds("core.product")).toEqual(["datos", "fotos", "extra", "archivos"]);
    expect(recordTabIds("core.product_category")).toEqual(["datos", "extra", "archivos"]);
  });
});
