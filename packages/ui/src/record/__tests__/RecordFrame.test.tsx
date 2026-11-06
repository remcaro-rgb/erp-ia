// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("seq 'masked' shows ID •••• (no copy) with the UUID, never 'El ID y el UUID se asignan al crear'", () => {
    render(<RecordFrame title="Cuenta restringida" seq="masked" uuid={id} deepLinkHref={recordHref("accounting.account", id)} tabs={[tab("saldos")]} />);
    expect(screen.getByText("ID ••••")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copiar ID" })).toBeNull();
    expect(screen.getByText(`UUID ${shortId(id)}…`)).toBeTruthy();
    expect(screen.queryByText(/se asignan al crear/)).toBeNull();
  });

  it("shows the title, the ID (D16) and the short UUID with copy buttons, and the status and actions in the footer", () => {
    render(party);
    expect(screen.getByRole("heading", { name: "Supermercados Éxito" })).toBeTruthy();
    expect(screen.getByText("ID 7")).toBeTruthy();
    expect(screen.getByText(`UUID ${shortId(id)}…`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar ID" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar UUID" })).toBeTruthy();
    expect(shortId(id)).toBe("0192a1b2");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Estado DIAN: completo")).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Guardar" })).toBeTruthy();
  });

  it("says the ID and UUID are assigned on create while the record is new, and offers no deep link", () => {
    render(<RecordFrame title="Nuevo tercero" tabs={[tab("datos")]} />);
    expect(screen.getByText("El ID y el UUID se asignan al crear")).toBeTruthy();
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

  // UI density audit quick win 14 (L3): Home and End in the record tabs, and the title and tabs stay in view.
  it("Home and End go to the first and last tab", () => {
    render(party);
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Datos$/ }), { key: "End" });
    const archivos = screen.getByRole("tab", { name: /^Archivos/ });
    expect(archivos.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(archivos);
    fireEvent.keyDown(archivos, { key: "Home" });
    expect(screen.getByRole("tab", { name: /^Datos$/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^Datos$/ }));
  });

  it("keeps the header and the tabs in a sticky block above the panels", () => {
    render(party);
    const sticky = screen.getByRole("heading", { name: "Supermercados Éxito" }).closest(".erp-record__top")!;
    expect(sticky).toBeTruthy();
    expect(within(sticky as HTMLElement).getByRole("tablist")).toBeTruthy();
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

describe("RecordFrame Duplicar (rule 37)", () => {
  const existing = (onDuplicate?: () => void, extra: Record<string, unknown> = {}) => (
    <RecordFrame title="Almacenes Éxito S.A." seq={7} uuid={id} deepLinkHref={recordHref("core.party", id)} tabs={[tab("datos")]} onDuplicate={onDuplicate} {...extra} />
  );

  it("offers Duplicar on an existing record and runs it on click", () => {
    const onDuplicate = vi.fn();
    render(existing(onDuplicate));
    const button = screen.getByRole("button", { name: "Duplicar" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+D Meta+D");
    fireEvent.click(button);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+D and ⌘+D duplicate and never reach the browser's bookmark", () => {
    const onDuplicate = vi.fn();
    render(existing(onDuplicate));
    const ctrl = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const meta = new KeyboardEvent("keydown", { key: "D", metaKey: true, bubbles: true, cancelable: true });
    screen.getByRole("tab", { name: /^Datos$/ }).dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(true);
    expect(onDuplicate).toHaveBeenCalledTimes(2);
    // Other chords are left alone.
    const plain = new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true });
    const shifted = new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(plain);
    document.body.dispatchEvent(shifted);
    expect(plain.defaultPrevented).toBe(false);
    expect(shifted.defaultPrevented).toBe(false);
    expect(onDuplicate).toHaveBeenCalledTimes(2);
  });

  it("leaves Ctrl/⌘+D to text boxes and to a dialog opened over the page, but answers it inside a frame shown in a dialog", () => {
    const onDuplicate = vi.fn();
    render(
      <>
        {existing(onDuplicate)}
        <input aria-label="caja" />
        <textarea aria-label="nota" />
        <select aria-label="lista">
          <option>a</option>
        </select>
        <div aria-label="editable" contentEditable suppressContentEditableWarning />
      </>,
    );
    const press = (target: Element, init: KeyboardEventInit = { ctrlKey: true }) => {
      const event = new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    for (const name of ["caja", "nota", "lista", "editable"]) {
      expect(press(screen.getByLabelText(name)).defaultPrevented).toBe(false);
      expect(press(screen.getByLabelText(name), { metaKey: true }).defaultPrevented).toBe(false);
    }
    expect(onDuplicate).not.toHaveBeenCalled();
    // ⌘D outside a text box still duplicates.
    expect(press(document.body, { metaKey: true }).defaultPrevented).toBe(true);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    // A modal over the page (the step-up prompt, the advanced filter…) keeps its keys.
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    expect(press(modal).defaultPrevented).toBe(false);
    expect(press(document.body).defaultPrevented).toBe(false);
    modal.remove();
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("answers Ctrl+D when the frame itself is shown in a dialog (the ticket sheet)", () => {
    const onDuplicate = vi.fn();
    render(
      <div role="dialog" aria-modal="true">
        {existing(onDuplicate)}
      </div>,
    );
    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByRole("tab", { name: /^Datos$/ }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a duplicate is under way, and stops listening once unmounted", () => {
    const onDuplicate = vi.fn();
    const { unmount } = render(existing(onDuplicate, { duplicating: true }));
    expect(screen.getByRole("button", { name: "Duplicar" }).hasAttribute("disabled")).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(onDuplicate).not.toHaveBeenCalled();
    unmount();
    const after = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("offers no Duplicar (and leaves Ctrl+D to the browser) without onDuplicate, e.g. on a new record", () => {
    render(<RecordFrame title="Crear tercero" tabs={[tab("datos")]} />);
    expect(screen.queryByRole("button", { name: "Duplicar" })).toBeNull();
    const ctrl = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
  });

  it("a new record made from a copy shows the banner \"Copia de <nombre>\" with a link to the source", () => {
    render(<RecordFrame title="Crear tercero" tabs={[tab("datos")]} copyOf={{ title: "Almacenes Éxito S.A.", href: recordHref("core.party", id) }} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Copia de Almacenes Éxito S.A.");
    expect(within(banner).getByRole("link", { name: "Almacenes Éxito S.A." }).getAttribute("href")).toBe(`/r/core.party/${id}`);
    expect(screen.queryByRole("button", { name: "Duplicar" })).toBeNull();
  });

  it("takes the banner's copy from labels", () => {
    render(<RecordFrame title="New party" tabs={[tab("datos")]} copyOf={{ title: "Éxito" }} labels={{ copyOf: "Copy of {name}", copyNote: "Fill in what identifies it." }} />);
    expect(screen.getByRole("status").textContent).toContain("Copy of Éxito");
    expect(screen.getByRole("status").textContent).toContain("Fill in what identifies it.");
  });
});

describe("record model", () => {
  it("builds the deep link from the entity id and the record id", () => {
    expect(recordHref("core.product", id)).toBe(`/r/core.product/${id}`);
    // A user has no record frame: their page is under Administración › Usuarios (design §22.15).
    expect(recordHref("kernel.user", id)).toBe(`/admin/users/${id}`);
  });

  it("parties show Contactos, products show Fotos, every record shows Datos adicionales and Archivos", () => {
    expect(recordTabIds("core.party")).toEqual(["datos", "contactos", "extra", "archivos", "versiones", "acceso"]);
    expect(recordTabIds("core.product")).toEqual(["datos", "fotos", "extra", "archivos", "versiones", "acceso"]);
    expect(recordTabIds("core.product_category")).toEqual(["datos", "extra", "archivos", "versiones", "acceso"]);
    expect(recordTabIds("support.ticket")).toEqual(["datos", "mensajes", "extra", "archivos", "versiones", "acceso"]);
  });

  it("contributed tabs come after the entity's own and before Datos adicionales", () => {
    expect(recordTabIds("core.party", ["accounting.entries"])).toEqual(["datos", "contactos", "accounting.entries", "extra", "archivos", "versiones", "acceso"]);
    expect(recordTabIds("core.product_category", ["a.x", "a.y"])).toEqual(["datos", "a.x", "a.y", "extra", "archivos", "versiones", "acceso"]);
  });

  it("an invoice and a note read Datos · Líneas e impuestos · Contabilidad · DIAN (plan 2B Task 20)", () => {
    expect(recordTabIds("invoicing.invoice", ["accounting.entries"])).toEqual(["datos", "lineas", "accounting.entries", "dian", "extra", "archivos", "versiones", "acceso"]);
    expect(recordTabIds("invoicing.note", ["accounting.entries"])).toEqual(["datos", "lineas", "accounting.entries", "dian", "extra", "archivos", "versiones", "acceso"]);
  });

  it("a recibo de caja reads Datos · Asignaciones · Contabilidad (plan 2B Task 24b)", () => {
    expect(recordTabIds("payments.receipt", ["accounting.entries"])).toEqual(["datos", "asignaciones", "accounting.entries", "extra", "archivos", "versiones", "acceso"]);
  });
});

describe("record frame ids (D16)", () => {
  it("shows Número and Ref. of a documento with their copy buttons", () => {
    render(<RecordFrame title="Comprobante" seq={1284} uuid={id} number="CE-000123" reference="FAC-77" tabs={[tab("datos")]} />);
    expect(screen.getByText("Número CE-000123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar Número" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar Ref." })).toBeTruthy();
  });
});

// Owner 2026-11-05: the record's buttons live in the tabs bar (right of the tabs), the footer keeps only the status; while the form holds
// unsaved changes the header shows «Descartar cambios» and «Guardar cambios» next to «Cambios sin guardar», and the state chip steps aside.
describe("RecordFrame, actions in the tabs bar and the unsaved state (owner 2026-11-05)", () => {
  const bar = (
    <div role="group" aria-label="Acciones del registro">
      <button type="button">Guardar</button>
    </div>
  );

  it("renders the toolbar in the tabs bar next to the tabs, and the footer keeps only the status", () => {
    const { container } = render(<RecordFrame title="Almacenes Éxito S.A." seq={1} uuid={id} tabs={[tab("datos"), tab("contactos")]} toolbar={bar} status={<span>DIAN: completo</span>} />);
    const tabsBar = container.querySelector(".erp-record__tabsbar")!;
    expect(tabsBar).toBeTruthy();
    expect(tabsBar.contains(screen.getByRole("tablist"))).toBe(true);
    expect(tabsBar.contains(screen.getByRole("group", { name: "Acciones del registro" }))).toBe(true);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(within(footer).getByText("DIAN: completo")).toBeTruthy();
    // The tabs stay the only children of the tablist (the toolbar is its sibling).
    expect(within(screen.getByRole("tablist")).queryByRole("button")).toBeNull();
  });

  it("hides the state chip («Grabado») while the record has unsaved changes", () => {
    const chip = <span className="erp-pill">Grabado</span>;
    const { rerender } = render(<RecordFrame title="Almacenes Éxito S.A." seq={1} uuid={id} tabs={[tab("datos")]} chip={chip} />);
    expect(screen.getByText("Grabado")).toBeTruthy();
    rerender(<RecordFrame title="Almacenes Éxito S.A." seq={1} uuid={id} tabs={[tab("datos")]} chip={chip} dirty />);
    expect(screen.queryByText("Grabado")).toBeNull();
  });

  it("shows «Descartar cambios» and «Guardar cambios» in the header only while dirty, and runs them", () => {
    const onDiscardChanges = vi.fn();
    const onSaveChanges = vi.fn();
    const frame = (dirty: boolean, saveBlocked = false) => (
      <RecordFrame title="Almacenes Éxito S.A." seq={1} uuid={id} tabs={[tab("datos")]} dirty={dirty} saveBlocked={saveBlocked} onDiscardChanges={onDiscardChanges} onSaveChanges={onSaveChanges} />
    );
    const { container, rerender } = render(frame(false));
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    rerender(frame(true));
    const header = container.querySelector(".erp-record__header") as HTMLElement;
    const discard = within(header).getByRole("button", { name: "Descartar cambios" });
    const save = within(header).getByRole("button", { name: "Guardar cambios" });
    expect(save.className).toContain("erp-btn--primary");
    fireEvent.click(discard);
    fireEvent.click(save);
    expect(onDiscardChanges).toHaveBeenCalledTimes(1);
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    rerender(frame(true, true));
    expect((within(header).getByRole("button", { name: "Guardar cambios" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("without a discard handler only «Guardar cambios» shows", () => {
    render(<RecordFrame title="Nuevo" tabs={[tab("datos")]} dirty onSaveChanges={() => {}} />);
    expect(screen.queryByRole("button", { name: "Descartar cambios" })).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeTruthy();
  });
});
