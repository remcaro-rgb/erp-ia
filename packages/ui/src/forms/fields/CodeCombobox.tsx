"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { useDianHints } from "../form-context";
import type { CodeOption } from "../save-model";

// A typeahead over a code table (municipality, department, unit of measure, category): type part of the name or the
// code, ↑ ↓ pick, Enter or Tab choose, Esc gives the chosen name back. Replaces the native select where the list is
// too long to scan (about 1,100 municipalities). The ARIA 1.2 combobox pattern with the list popup.

/** Lower case without accents: "Medellin" finds "Medellín". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The list stops here; the box says to type more (the largest table, the municipalities of a department, has fewer). */
const MAX_LISTED = 200;

export interface CodeComboboxProps {
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  /** The chosen code, or "" for none. */
  value: string;
  options: readonly CodeOption[];
  onChange: (code: string) => void;
  /** Placeholder of the empty value; when present the value can be cleared. */
  empty?: string;
  /** The code is part of how the user finds and reads an option (default). False for lists whose codes are internal ids. */
  showCode?: boolean;
  disabled?: boolean;
  className?: string;
}

export function CodeCombobox({ id, value, options, onChange, empty, showCode: hasCodes = true, disabled, className, ...aria }: CodeComboboxProps) {
  const t = useTranslations("common.forms");
  const showCode = useDianHints() && hasCodes;
  const listId = useId();
  const optionId = (code: string) => `${listId}-${code}`;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The user typed a search or walked the list: Enter and Tab may choose. A list only opened by a click chooses nothing. */
  const intent = useRef(false);

  const labelOf = (o: CodeOption) => (showCode ? `${o.code} · ${o.name}` : o.name);
  const chosen = options.find((o) => o.code === value);
  const chosenLabel = chosen ? labelOf(chosen) : value;

  const query = fold(text.trim());
  const matches = open ? (editing && query ? options.filter((o) => fold(o.name).includes(query) || (hasCodes && fold(o.code).includes(query))) : options) : [];
  const listed = matches.slice(0, MAX_LISTED);
  const current = listed[active];

  // The active option stays in view while the arrows walk a long list.
  useLayoutEffect(() => {
    if (!open || !current) return;
    document.getElementById(optionId(current.code))?.scrollIntoView?.({ block: "nearest" });
  });

  const close = () => {
    intent.current = false;
    setOpen(false);
    setEditing(false);
  };
  const choose = (option: CodeOption) => {
    close();
    if (option.code !== value) onChange(option.code);
  };
  const openList = () => {
    if (open) return;
    intent.current = false;
    setActive(Math.max(0, options.findIndex((o) => o.code === value)));
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) {
          openList();
          intent.current = true;
          break;
        }
        intent.current = true;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((a) => Math.min(Math.max(a + step, 0), Math.max(listed.length - 1, 0)));
        break;
      }
      case "Enter":
        // Closed: the form takes the Enter and moves to the next field. Open: it chooses (or, with nothing listed, waits).
        if (!open) break;
        event.preventDefault();
        if (current && intent.current) choose(current);
        else close();
        break;
      case "Escape":
        if (!open && !editing) break;
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case "Tab":
        // Chooses what the list points at and lets the browser move on.
        if (open && current && intent.current) choose(current);
        else close();
        break;
    }
  };

  const onBlur = () => {
    // Left with the mouse or by a field that took the focus: a half-typed text is dropped, an emptied box empties the value.
    if (editing && empty !== undefined && text.trim() === "" && value !== "") onChange("");
    close();
  };

  const shown = editing ? text : chosenLabel;
  return (
    <div className={["erp-combo", className].filter(Boolean).join(" ")}>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && current ? optionId(current.code) : undefined}
        aria-label={aria["aria-label"]}
        aria-invalid={aria["aria-invalid"]}
        aria-describedby={aria["aria-describedby"]}
        autoComplete="off"
        spellCheck={false}
        className={aria["aria-invalid"] ? "erp-input--bad" : undefined}
        placeholder={empty}
        disabled={disabled}
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          setEditing(true);
          intent.current = e.target.value.trim() !== "";
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => e.target.select()}
        onClick={() => openList()}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {open && (
        <div className="erp-combo__pop" onMouseDown={(e) => e.preventDefault()}>
          <ul id={listId} role="listbox" aria-label={aria["aria-label"]} className="erp-combo__list">
            {listed.map((o, i) => (
              <li
                key={o.code}
                id={optionId(o.code)}
                role="option"
                aria-selected={i === active}
                className={["erp-combo__opt", i === active && "is-on", o.code === value && "is-chosen"].filter(Boolean).join(" ")}
                // The box keeps the focus: a click must not blur it before the choice lands.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(o)}
              >
                {labelOf(o)}
              </li>
            ))}
            {listed.length === 0 && (
              <li role="option" aria-selected={false} aria-disabled="true" className="erp-combo__none">
                {t("combo_empty")}
              </li>
            )}
          </ul>
          {matches.length > listed.length && <div className="erp-combo__more">{t("combo_more", { count: matches.length - listed.length })}</div>}
        </div>
      )}
    </div>
  );
}
