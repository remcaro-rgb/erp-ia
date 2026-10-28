"use client";

import { useState } from "react";
import { EmailField } from "../fields/EmailField";
import { PhoneField } from "../fields/PhoneField";
import { digitsOnly, formatPhone, phoneValue, type VerifyKind, type VerifyStatus } from "../fields/field-model";
import { DEFAULT_CONTACTS_LABELS, contactProblems, draftOf, emptyDraft, type ContactDraft, type ContactItem, type ContactsLabels } from "./contacts-model";

export type { ContactDraft, ContactItem, ContactsLabels } from "./contacts-model";

export interface ContactsTabProps {
  contacts: readonly ContactItem[];
  /** Hides the add form and the remove buttons. */
  readOnly?: boolean;
  /** `core.contact.create`; a rejection keeps the form open and shows its message. */
  onCreate?: (draft: ContactDraft) => Promise<void> | void;
  /** `core.contact.update`. */
  onUpdate?: (id: string, draft: ContactDraft) => Promise<void> | void;
  /** `core.contact.delete`, after the user confirmed. */
  onRemove?: (id: string) => Promise<void> | void;
  /** The Verificar control of the form's e-mail and phones. */
  verify?: {
    statusOf?: (kind: VerifyKind, value: string) => VerifyStatus | undefined;
    onVerify: (kind: VerifyKind, value: string) => void;
  };
  labels?: Partial<ContactsLabels>;
  /** Appended to the root's `erp-contacts` class. */
  className?: string;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Contactos" of a party (design §5.18, prototype v5): the people at a customer or supplier, listed in a
 * table and edited in an inline form with validated phone and e-mail fields. Removing asks for confirmation.
 * The tab holds no data of its own: the page loads the contacts and runs the processes through the callbacks.
 */
export function ContactsTab({ contacts, readOnly = false, onCreate, onUpdate, onRemove, verify, labels: overrides, className }: ContactsTabProps) {
  const labels: ContactsLabels = { ...DEFAULT_CONTACTS_LABELS, ...overrides };
  const [form, setForm] = useState<{ id: string | null; draft: ContactDraft } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (change: Partial<ContactDraft>) => setForm((current) => (current ? { ...current, draft: { ...current.draft, ...change } } : current));
  const problems = form ? contactProblems(form.draft, labels) : {};
  const blocked = Object.keys(problems).length > 0;
  const phoneVerify = (cc: string, number: string) =>
    verify && { status: verify.statusOf?.("phone", phoneValue(cc, number)), onVerify: (value: string) => verify.onVerify("phone", value) };

  const submit = async () => {
    if (!form || blocked) return;
    setBusy(true);
    setMessage(null);
    try {
      if (form.id) await onUpdate?.(form.id, form.draft);
      else await onCreate?.(form.draft);
      setForm(null);
    } catch (error) {
      setMessage(labels.saveFailed(reason(error)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await onRemove?.(id);
    } catch (error) {
      setMessage(labels.removeFailed(reason(error)));
    }
  };

  return (
    <div className={["erp-contacts", className].filter(Boolean).join(" ")}>
      {form && !readOnly && (
        <section className="erp-contacts__form">
          <h3>{form.id ? labels.editTitle : labels.newTitle}</h3>
          <div className="erp-contacts__fields">
            <div className="erp-field">
              <label htmlFor="erp-contact-name">{labels.name}</label>
              <input id="erp-contact-name" type="text" maxLength={200} value={form.draft.name} onChange={(event) => patch({ name: event.target.value })} />
            </div>
            <div className="erp-field">
              <label htmlFor="erp-contact-job">{labels.jobTitle}</label>
              <input id="erp-contact-job" type="text" maxLength={100} value={form.draft.jobTitle} onChange={(event) => patch({ jobTitle: event.target.value })} />
            </div>
            <EmailField
              label={labels.email}
              value={form.draft.email}
              onChange={(email) => patch({ email })}
              verify={verify ? { status: verify.statusOf?.("email", form.draft.email), onVerify: (value) => verify.onVerify("email", value) } : undefined}
            />
            <PhoneField
              label={labels.phone}
              cc={form.draft.phoneCc}
              number={form.draft.phone}
              onChange={({ cc, number }) => patch({ phoneCc: cc, phone: number })}
              verify={phoneVerify(form.draft.phoneCc, form.draft.phone)}
            />
            <div className="erp-field">
              <label htmlFor="erp-contact-ext">{labels.ext}</label>
              <input id="erp-contact-ext" type="text" inputMode="numeric" maxLength={6} value={form.draft.ext} onChange={(event) => patch({ ext: digitsOnly(event.target.value) })} />
            </div>
            <PhoneField
              label={labels.mobile}
              cc={form.draft.mobileCc}
              number={form.draft.mobile}
              onChange={({ cc, number }) => patch({ mobileCc: cc, mobile: number })}
              verify={phoneVerify(form.draft.mobileCc, form.draft.mobile)}
            />
          </div>
          {problems.name && form.draft.name !== "" && <p className="erp-field__error">{problems.name}</p>}
          {problems.channel && <p className="erp-field__hint">{problems.channel}</p>}
          {message && (
            <p role="alert" className="erp-field__error">
              {message}
            </p>
          )}
          <div className="erp-contacts__actions">
            <button type="button" onClick={() => setForm(null)}>
              {labels.cancel}
            </button>
            <button type="button" disabled={blocked || busy} onClick={() => void submit()}>
              {form.id ? labels.save : labels.create}
            </button>
          </div>
        </section>
      )}

      <section className="erp-contacts__list">
        <div className="erp-contacts__head">
          <h3>
            {labels.title} <span className="erp-pill erp-pill--gray">{contacts.length}</span>
          </h3>
          {!readOnly && !form && (
            <button type="button" onClick={() => setForm({ id: null, draft: emptyDraft() })}>
              {labels.add}
            </button>
          )}
        </div>
        {!form && message && (
          <p role="alert" className="erp-field__error">
            {message}
          </p>
        )}
        {contacts.length === 0 ? (
          <p className="erp-contacts__muted">{labels.empty}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{labels.name}</th>
                <th>{labels.jobTitle}</th>
                <th>{labels.email}</th>
                <th>{labels.phone}</th>
                <th>{labels.ext}</th>
                <th>{labels.mobile}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) =>
                confirming === contact.id ? (
                  <tr key={contact.id} role="alertdialog" aria-label={labels.confirmRemove(contact.name)}>
                    <td colSpan={7}>
                      {labels.confirmRemove(contact.name)}{" "}
                      <button type="button" onClick={() => void remove(contact.id)}>
                        {labels.confirmYes}
                      </button>{" "}
                      <button type="button" onClick={() => setConfirming(null)}>
                        {labels.confirmNo}
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={contact.id} onClick={readOnly ? undefined : () => setForm({ id: contact.id, draft: draftOf(contact) })} className={readOnly ? undefined : "erp-contacts__row--clickable"}>
                    <td>{contact.name}</td>
                    <td>{contact.jobTitle}</td>
                    <td>{contact.email}</td>
                    <td>{formatPhone(contact.phoneCc, contact.phone)}</td>
                    <td>{contact.ext}</td>
                    <td>{formatPhone(contact.mobileCc, contact.mobile)}</td>
                    <td>
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={labels.remove(contact.name)}
                          onClick={(event) => {
                            event.stopPropagation();
                            setConfirming(contact.id);
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
