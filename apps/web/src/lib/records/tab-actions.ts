"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { ContactDraft, SaveIssue } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { issuesOf } from "./issues";

// What the record page's tabs do (rule 1: every change is a registered process, run as the session's user): the
// contact processes of a party, the photo order and the AI photo suggestion, and the Verificar control. A refusal
// comes back as data (the process's code and messages), not as a thrown error, so the tab can show it in place.

/** The attachment `kernel.ai.image_suggest` stored. */
export interface AttachmentSummary {
  id: string;
  tag: string;
  fileName: string;
  mimeType: string;
  suggested: boolean;
}

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; details: SaveIssue[] };

async function perform<O, T>(processId: string, input: unknown, answer: (output: O) => T, stepUpToken?: string): Promise<ActionResult<T>> {
  // A sensitive process answers `step_up_required`; the tab asks for the code and runs the action again with the token.
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    return { ok: true, ...answer((await runProcess(processDeps(), caller, processId, input)) as O) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

/** A contact draft as the contact processes take it: only the form's fields, "" clearing a datum. */
const contactFields = (draft: ContactDraft) => ({
  name: draft.name,
  jobTitle: draft.jobTitle,
  email: draft.email,
  phoneCc: draft.phoneCc,
  phone: draft.phone,
  ext: draft.ext,
  mobileCc: draft.mobileCc,
  mobile: draft.mobile,
});

const ids = (output: { id: string }) => ({ id: output.id });

/** `core.contact.create` for a party. */
export async function createContactAction(partyId: string, draft: ContactDraft, stepUpToken?: string) {
  return perform<{ id: string }, { id: string }>("core.contact.create", { partyId, ...contactFields(draft) }, ids, stepUpToken);
}

/** `core.contact.update`. */
export async function updateContactAction(id: string, draft: ContactDraft, stepUpToken?: string) {
  return perform<{ id: string }, { id: string }>("core.contact.update", { id, ...contactFields(draft) }, ids, stepUpToken);
}

/** `core.contact.delete`. */
export async function removeContactAction(id: string, stepUpToken?: string) {
  return perform<{ id: string }, { id: string }>("core.contact.delete", { id }, ids, stepUpToken);
}

/** `kernel.attachment.reorder`: the photos in their new order, the principal one first. */
export async function reorderPhotosAction(entity: string, recordId: string, orderedIds: string[], stepUpToken?: string) {
  return perform<unknown, object>("kernel.attachment.reorder", { entity, recordId, orderedIds }, () => ({}), stepUpToken);
}

/** `kernel.ai.image_suggest`: "Sugerir foto con IA". The stored picture comes back as the attachment. */
export async function suggestPhotoAction(entity: string, recordId: string, hints: { description: string; uom?: string; category?: string }, stepUpToken?: string) {
  return perform<AttachmentSummary, { attachment: AttachmentSummary }>("kernel.ai.image_suggest", { entity, recordId, ...hints }, (attachment) => ({ attachment }), stepUpToken);
}

/**
 * `kernel.verify.request` for an e-mail or a phone (rule 11, design §5.16). Contacts are verified against their party:
 * a contact being typed has no id yet, and the request is about the datum of that party's record.
 */
export async function requestVerificationAction(entity: string, recordId: string, kind: "email" | "phone" | "document", value: string, stepUpToken?: string) {
  return perform<{ status: "queued" | "verified" | "failed" }, { status: "queued" | "verified" | "failed" }>("kernel.verify.request", { kind, value, entity, recordId }, (output) => ({ status: output.status }), stepUpToken);
}
