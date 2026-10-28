"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ContactsTab, type ContactDraft, type ContactItem } from "@erp/ui";
import { createContactAction, removeContactAction, requestVerificationAction, updateContactAction } from "@/lib/records/tab-actions";
import type { RecordAbilities } from "@/lib/records/load";
import { refusalText } from "./refusal";

type Status = "queued" | "verified" | "failed";

export interface ContactsPanelProps {
  partyId: string;
  contacts: readonly ContactItem[];
  can: Pick<RecordAbilities, "contactCreate" | "contactUpdate" | "contactDelete" | "verify">;
}

/**
 * The Contactos tab of a party wired to the contact processes: each control exists only when the caller's role may run
 * its process, a refusal shows its message in the form, and the page reloads the list after every change. Verificar
 * asks `kernel.verify.request` for the datum on the party's record and shows the status it answers ("en cola" while
 * no provider is configured).
 */
export function ContactsPanel({ partyId, contacts, can }: ContactsPanelProps) {
  const router = useRouter();
  const te = useTranslations("errors");
  const [statuses, setStatuses] = useState<Record<string, Status>>({});

  const refused = (result: { code: string; details: Parameters<typeof refusalText>[1]["details"] }) => new Error(refusalText(te, result));
  const done = async (result: Awaited<ReturnType<typeof createContactAction>>) => {
    if (!result.ok) throw refused(result);
    router.refresh();
  };

  const onVerify = async (kind: "email" | "phone", value: string) => {
    const result = await requestVerificationAction("core.party", partyId, kind, value);
    setStatuses((current) => ({ ...current, [`${kind}:${value}`]: result.ok ? result.status : "failed" }));
  };

  return (
    <ContactsTab
      contacts={contacts}
      onCreate={can.contactCreate ? async (draft: ContactDraft) => done(await createContactAction(partyId, draft)) : undefined}
      onUpdate={can.contactUpdate ? async (id: string, draft: ContactDraft) => done(await updateContactAction(id, draft)) : undefined}
      onRemove={can.contactDelete ? async (id: string) => done(await removeContactAction(id)) : undefined}
      verify={can.verify ? { statusOf: (kind, value) => statuses[`${kind}:${value}`], onVerify: (kind, value) => void (kind === "document" ? undefined : onVerify(kind, value)) } : undefined}
    />
  );
}
