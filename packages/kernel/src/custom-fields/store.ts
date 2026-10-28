import type { Tx } from "../db/client";
import type { CustomFieldDef } from "./types";

/** `kernel.custom_fields` as the validators read it. */
export interface CustomFieldRow extends CustomFieldDef {
  id: string;
  entity: string;
}

interface Stored {
  id: string;
  entity: string;
  key: string;
  label: string;
  type: CustomFieldDef["type"];
  max_length: number | null;
  required: boolean;
  options: string[] | null;
  roles_enter: string[];
  roles_edit: string[];
  roles_view: string[];
}

/** The definitions of `entityId` in the caller's company (company RLS applies), ordered by label then key. */
export async function loadCustomFields(tx: Tx, entityId: string): Promise<CustomFieldRow[]> {
  const rows = await tx<Stored[]>`
    select id, entity, key, label, type, max_length, required, options, roles_enter, roles_edit, roles_view
    from kernel.custom_fields where entity = ${entityId} order by label, key`;
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    key: r.key,
    label: r.label,
    type: r.type,
    maxLength: r.max_length,
    required: r.required,
    options: r.options,
    rolesEnter: r.roles_enter,
    rolesEdit: r.roles_edit,
    rolesView: r.roles_view,
  }));
}
