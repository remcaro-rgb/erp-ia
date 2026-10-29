// Enter-to-next in the record forms (OD-11): the form's one key handler asks these which field comes next. Plain DOM,
// so it works for every control the forms render (inputs, selects, the code combobox) without each knowing about it.

const TEXT_TYPES = new Set(["text", "email", "tel", "number", "search", "url", "password", "date", "datetime-local", "month", "week", "time"]);

/** Whether an Enter typed in `target` means "next field": a text-like input or a select, not a button, a textarea or an open list. */
export function isEnterSource(target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement {
  if (target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  if (target.getAttribute("aria-expanded") === "true") return false;
  return TEXT_TYPES.has(target.type) || target.type === "checkbox";
}

/** The fields Enter may land on, in DOM order: enabled, writable, in the tab order, visible, not opted out. */
export function enterFields(form: HTMLElement): HTMLElement[] {
  return Array.from(form.querySelectorAll<HTMLElement>("input, select, textarea")).filter((el) => {
    const field = el as HTMLInputElement;
    if (field.disabled || field.readOnly || field.type === "hidden") return false;
    if (el.tabIndex < 0) return false;
    return !el.closest("[hidden], [aria-hidden='true'], [data-enter-skip]");
  });
}

/** The field after (or, with `back`, before) `from` in document order, or null when `from` is the last (first). */
export function enterTarget(form: HTMLElement, from: HTMLElement, back: boolean): HTMLElement | null {
  const fields = enterFields(form);
  if (back) {
    for (let i = fields.length - 1; i >= 0; i--) if (fields[i]!.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) return fields[i]!;
    return null;
  }
  return fields.find((f) => f.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING) ?? null;
}

/** Moves the caret to `field`, text selected so typing replaces it (desktop ERP habit). */
export function focusField(field: HTMLElement): void {
  field.focus();
  if (field instanceof HTMLInputElement && TEXT_TYPES.has(field.type)) {
    try {
      field.select();
    } catch {
      // Some input types refuse a selection; the caret is where it should be.
    }
  }
}
