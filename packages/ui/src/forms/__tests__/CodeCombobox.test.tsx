// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { CodeCombobox } from "../fields/CodeCombobox";
import { FormPrefsProvider } from "../form-context";
import { CodeComboboxField, RecordForm } from "../form-parts";

afterEach(cleanup);

// The typeahead over a code table (municipality, department, unit): ARIA combobox, ↑↓ Enter Esc Tab, accent-insensitive.

const options = [
  { code: "05001", name: "Medellín" },
  { code: "05045", name: "Apartadó" },
  { code: "05088", name: "Bello" },
  { code: "05360", name: "Itagüí" },
];

function Harness({ initial = "", onChange, empty = "—", disabled }: { initial?: string; onChange?: (v: string) => void; empty?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <input aria-label="antes" />
      <CodeCombobox
        id="c"
        aria-label="Municipio"
        value={value}
        options={options}
        empty={empty}
        disabled={disabled}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <input aria-label="después" />
    </>
  );
}

const box = () => screen.getByRole("combobox", { name: "Municipio" }) as HTMLInputElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(box(), { key: k, ...init });

describe("CodeCombobox", () => {
  it("shows the chosen name, or the placeholder for an empty value, and is a combobox", () => {
    renderEs(<Harness initial="05088" />);
    expect(box().value).toBe("Bello");
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(box().getAttribute("aria-autocomplete")).toBe("list");
    cleanup();
    renderEs(<Harness />);
    expect(box().value).toBe("");
    expect(box().placeholder).toBe("—");
  });

  it("filters by name without accents or case, and by code", () => {
    renderEs(<Harness />);
    type("medellin");
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Medellín"]);
    type("ITAGUI");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Itagüí"]);
    type("05045");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Apartadó"]);
    type("zzz");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Sin coincidencias"]);
  });

  it("links the input to the list and to the active option", () => {
    renderEs(<Harness />);
    type("a");
    const list = screen.getByRole("listbox");
    expect(box().getAttribute("aria-controls")).toBe(list.id);
    const options = screen.getAllByRole("option");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
  });

  it("↑ ↓ move the active option (stopping at the ends) and Enter chooses it", () => {
    const onChange = vi.fn();
    renderEs(<Harness onChange={onChange} />);
    type("a");
    // Of the four names only Apartadó and Itagüí contain an "a".
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Apartadó", "Itagüí"]);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
    key("ArrowDown");
    expect(fireEvent.keyDown(box(), { key: "Enter" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith("05360");
    expect(box().value).toBe("Itagüí");
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("names the list by the field's label text, never by its DIAN hint", () => {
    renderEs(
      <FormPrefsProvider value={{ dianHints: true, setDianHints: () => {} }}>
        <RecordForm canSave onSave={() => {}} failure={null}>
          <CodeComboboxField label="Municipio" hint="DANE · CityCode" hintKind="dian" value="" options={options} onChange={() => {}} />
        </RecordForm>
      </FormPrefsProvider>,
    );
    // The hint shows (DIAN hints on) and still describes the box, but is no part of the list's name.
    expect(screen.getByText("DANE · CityCode")).toBeTruthy();
    const input = screen.getByRole("combobox", { name: /^Municipio/ });
    fireEvent.change(input, { target: { value: "a" } });
    const list = screen.getByRole("listbox");
    const label = document.getElementById(list.getAttribute("aria-labelledby")!)!;
    expect(label.textContent).toBe("Municipio");
    expect(label.closest("label")).not.toBeNull();
    expect(screen.getByRole("listbox", { name: "Municipio" })).toBe(list);
  });

  it("points at no option (no active descendant, no selected row) until the user types or walks the list", () => {
    renderEs(<Harness />);
    fireEvent.click(box());
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
    const rows = screen.getAllByRole("option");
    // Row 0 is as neutral as the others.
    for (const row of rows) {
      expect(row.getAttribute("aria-selected")).toBe("false");
      expect(row.classList.contains("is-on")).toBe(false);
    }
    // The first ↓ points at row 0, the next one walks on.
    key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(rows[0]!.id);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.classList.contains("is-on")).toBe(true);
    key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
  });

  it("a list opened by a click on a chosen value points at nothing; the first ↓ points at the chosen row", () => {
    renderEs(<Harness initial="05088" />);
    fireEvent.click(box());
    expect(screen.getByRole("option", { name: "Bello" }).getAttribute("aria-selected")).toBe("false");
    key("ArrowDown");
    expect(screen.getByRole("option", { name: "Bello" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Ctrl/⌘+Enter chooses the active option but does not claim the key, so the form can save the choice", () => {
    const onChange = vi.fn();
    renderEs(<Harness onChange={onChange} />);
    type("medellin");
    expect(fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true })).toBe(true);
    expect(onChange).toHaveBeenCalledWith("05001");
    expect(box().value).toBe("Medellín");
  });

  it("Ctrl/⌘+S commits the active option like Ctrl/⌘+Enter and does not claim the key", () => {
    const onChange = vi.fn();
    renderEs(<Harness onChange={onChange} />);
    type("medellin");
    expect(fireEvent.keyDown(box(), { key: "s", ctrlKey: true })).toBe(true);
    expect(onChange).toHaveBeenCalledWith("05001");
    expect(box().value).toBe("Medellín");
    type("bel");
    expect(fireEvent.keyDown(box(), { key: "S", metaKey: true })).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("05088");
  });

  it("Ctrl+S with a half-typed text that points at nothing drops the text and keeps the value", () => {
    const onChange = vi.fn();
    renderEs(<Harness initial="05088" onChange={onChange} />);
    type("zzz");
    expect(fireEvent.keyDown(box(), { key: "s", ctrlKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(box().value).toBe("Bello");
  });

  it("Ctrl+Enter with a half-typed text that points at nothing drops the text and keeps the value", () => {
    const onChange = vi.fn();
    renderEs(<Harness initial="05088" onChange={onChange} />);
    type("zzz");
    expect(fireEvent.keyDown(box(), { key: "Enter", metaKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(box().value).toBe("Bello");
  });

  it("Enter with the list closed is left to the form (it moves on)", () => {
    renderEs(<Harness initial="05088" />);
    expect(fireEvent.keyDown(box(), { key: "Enter" })).toBe(true);
  });

  it("↓ opens the full list on the chosen option", () => {
    renderEs(<Harness initial="05088" />);
    key("ArrowDown");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: "Bello" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Esc closes the list and puts the chosen name back", () => {
    const onChange = vi.fn();
    renderEs(<Harness initial="05088" onChange={onChange} />);
    type("med");
    expect(box().value).toBe("med");
    key("Escape");
    expect(box().value).toBe("Bello");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Tab chooses the active option when the list is open, then moves on", () => {
    const onChange = vi.fn();
    renderEs(<Harness onChange={onChange} />);
    type("bel");
    // Tab is not prevented: the browser moves the focus.
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true);
    expect(onChange).toHaveBeenCalledWith("05088");
    expect(box().value).toBe("Bello");
  });

  it("Tab with the list closed chooses nothing", () => {
    const onChange = vi.fn();
    renderEs(<Harness initial="05088" onChange={onChange} />);
    key("Tab");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaving the box with a half-typed text puts the name back; clearing it and leaving empties the value", () => {
    const onChange = vi.fn();
    renderEs(<Harness initial="05088" onChange={onChange} />);
    type("xx");
    fireEvent.blur(box());
    expect(box().value).toBe("Bello");
    expect(onChange).not.toHaveBeenCalled();
    type("");
    fireEvent.blur(box());
    expect(onChange).toHaveBeenCalledWith("");
    expect(box().value).toBe("");
  });

  it("a click on an option chooses it", () => {
    const onChange = vi.fn();
    renderEs(<Harness onChange={onChange} />);
    type("med");
    fireEvent.click(screen.getByRole("option", { name: "Medellín" }));
    expect(onChange).toHaveBeenCalledWith("05001");
  });

  it("can be disabled", () => {
    renderEs(<Harness initial="05088" disabled />);
    expect(box().disabled).toBe(true);
  });

  it("shows the code beside the name only while the DIAN hints are on", () => {
    const setDianHints = vi.fn();
    const { rerender } = renderEs(
      <FormPrefsProvider value={{ dianHints: false, setDianHints }}>
        <RecordForm canSave onSave={() => {}} failure={null}>
          <CodeComboboxField label="Municipio" value="05088" options={options} onChange={() => {}} />
        </RecordForm>
      </FormPrefsProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Municipio" }).getAttribute("value")).toBe("Bello");
    rerender(
      <FormPrefsProvider value={{ dianHints: true, setDianHints }}>
        <RecordForm canSave onSave={() => {}} failure={null}>
          <CodeComboboxField label="Municipio" value="05088" options={options} onChange={() => {}} />
        </RecordForm>
      </FormPrefsProvider>,
    );
    expect((screen.getByRole("combobox", { name: "Municipio" }) as HTMLInputElement).value).toBe("05088 · Bello");
    fireEvent.change(screen.getByRole("combobox", { name: "Municipio" }), { target: { value: "bel" } });
    expect(screen.getByRole("option", { name: "05088 · Bello" })).toBeTruthy();
  });
});
