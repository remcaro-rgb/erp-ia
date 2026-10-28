"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ContactsTab, type ContactDraft, type ContactItem } from "@erp/ui";
import { createContactAction, removeContactAction, requestVerificationAction, updateContactAction, type ActionResult } from "@/lib/records/tab-actions";
import type { RecordAbilities } from "@/lib/records/load";
import { refusalText } from "./refusal";
import { useStepUpAction } from "./use-step-up";

type Status = "queued" | "verified" | "failed";

export interface ContactsPanelProps {
  partyId: string;
  contacts: readonly ContactItem[];
  can: Pick<RecordAbilities, "contactCreate" | "contactUpdate" | "contactDelete" | "verify">;
  /** The latest verification status of each contact datum, by `<kind>:<value>`, as the server knows it. */
  verifications: Record<string, Status>;
}

/**
 * The Contactos tab of a party wired to the contact processes: each control exists only when the caller's role may run
 * its process, a sensitive process asks for the step-up code, a refusal shows its message in the form, and the page
 * reloads the list after every change. Verificar asks `kernel.verify.request` for the datum on the party's record and
 * shows the status it answers ("en cola" while no provider is configured); the status the server already holds comes
 * with the page, so it survives a reload.
 */
export function ContactsPanel({ partyId, contacts, can, verifications }: ContactsPanelProps) {
  const router = useRouter();
  const te = useTranslations("errors");
  const { run, prompt } = useStepUpAction();
  const [statuses, setStatuses] = useState<Record<string, Status>>(verifications);

  const done = async (action: (stepUpToken?: string) => Promise<ActionResult<{ id: string }>>) => {
    const result = await run(action);
    if (!result.ok) throw new Error(refusalText(te, result));
    router.refresh();
  };

  const onVerify = async (kind: "email" | "phone", value: string) => {
    const key = `${kind}:${value}`;
    try {
      const result = await run((token) => requestVerificationAction("core.party", partyId, kind, value, token));
      setStatuses((current) => ({ ...current, [key]: result.ok ? result.status : "failed" }));
    } catch {
      setStatuses((current) => ({ ...current, [key]: "failed" }));
    }
  };

  return (
    <>
      {prompt}
      <ContactsTab
        contacts={contacts}
        onCreate={can.contactCreate ? (draft: ContactDraft) => done((token) => createContactAction(partyId, draft, token)) : undefined}
        onUpdate={can.contactUpdate ? (id: string, draft: ContactDraft) => done((token) => updateContactAction(id, draft, token)) : undefined}
        onRemove={can.contactDelete ? (id: string) => done((token) => removeContactAction(id, token)) : undefined}
        verify={can.verify ? { statusOf: (kind, value) => statuses[`${kind}:${value}`], onVerify: (kind, value) => (kind === "document" ? undefined : onVerify(kind, value)) } : undefined}
      />
    </>
  );
}
