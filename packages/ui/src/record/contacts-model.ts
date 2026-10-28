// Types, default copy and pure rules of the "Contactos" tab of a party (design §5.18, rule 11).

import { emailProblem, phoneProblem } from "../fields/field-model";

/** A contact as `core.contact.list` returns it. */
export interface ContactItem {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  phoneCc: string | null;
  phone: string | null;
  ext: string | null;
  mobileCc: string | null;
  mobile: string | null;
}

/** The form's contact: every datum a string, "" when empty. Maps one to one to the create / update input. */
export interface ContactDraft {
  name: string;
  jobTitle: string;
  email: string;
  phoneCc: string;
  phone: string;
  ext: string;
  mobileCc: string;
  mobile: string;
}

export interface ContactsLabels {
  title: string;
  add: string;
  newTitle: string;
  editTitle: string;
  create: string;
  save: string;
  cancel: string;
  name: string;
  jobTitle: string;
  email: string;
  phone: string;
  ext: string;
  mobile: string;
  empty: string;
  remove: (name: string) => string;
  confirmRemove: (name: string) => string;
  confirmYes: string;
  confirmNo: string;
  nameRequired: string;
  channelRequired: string;
  saveFailed: (reason: string) => string;
  removeFailed: (reason: string) => string;
  verifyFailed: (reason: string) => string;
}

/** Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export const DEFAULT_CONTACTS_LABELS: ContactsLabels = {
  title: "Contactos",
  add: "+ Nuevo contacto",
  newTitle: "Nuevo contacto",
  editTitle: "Editar contacto",
  create: "Agregar contacto",
  save: "Guardar contacto",
  cancel: "Cancelar",
  name: "Nombre",
  jobTitle: "Cargo",
  email: "Correo",
  phone: "Teléfono",
  ext: "Extensión",
  mobile: "Celular",
  empty: "Sin contactos. Agrega a las personas con quienes tratas: compras, tesorería, logística.",
  remove: (name) => `Quitar a ${name}`,
  confirmRemove: (name) => `¿Quitar a ${name}?`,
  confirmYes: "Sí, quitar",
  confirmNo: "No",
  nameRequired: "El nombre es obligatorio",
  channelRequired: "Indica al menos un correo o teléfono",
  saveFailed: (reason) => `No se pudo guardar el contacto: ${reason}`,
  removeFailed: (reason) => `No se pudo quitar el contacto: ${reason}`,
  verifyFailed: (reason) => `No se pudo pedir la verificación: ${reason}`,
};

export const emptyDraft = (): ContactDraft => ({ name: "", jobTitle: "", email: "", phoneCc: "57", phone: "", ext: "", mobileCc: "57", mobile: "" });

export const draftOf = (contact: ContactItem): ContactDraft => ({
  name: contact.name,
  jobTitle: contact.jobTitle ?? "",
  email: contact.email ?? "",
  phoneCc: contact.phoneCc ?? "57",
  phone: contact.phone ?? "",
  ext: contact.ext ?? "",
  mobileCc: contact.mobileCc ?? "57",
  mobile: contact.mobile ?? "",
});

export interface ContactProblems {
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  /** Neither an e-mail nor a phone: a contact nobody can reach is not a contact. */
  channel?: string;
}

/** What stops the draft from being saved; empty when it can be. The server checks again (rule 11). */
export function contactProblems(draft: ContactDraft, labels: Pick<ContactsLabels, "nameRequired" | "channelRequired"> = DEFAULT_CONTACTS_LABELS): ContactProblems {
  const problems: ContactProblems = {};
  if (draft.name.trim() === "") problems.name = labels.nameRequired;
  const email = emailProblem(draft.email);
  if (email) problems.email = email;
  const phone = phoneProblem(draft.phoneCc, draft.phone);
  if (phone) problems.phone = phone;
  const mobile = phoneProblem(draft.mobileCc, draft.mobile);
  if (mobile) problems.mobile = mobile;
  if (draft.name.trim() !== "" && !draft.email && !draft.phone && !draft.mobile) problems.channel = labels.channelRequired;
  return problems;
}
