import type { EntityDef, FieldDef, FieldType } from "@erp/kernel";

// Entities of the support module (design §8): tickets and their conversation. Labels are i18n keys
// (`entity.<id>`, `field.<id>.<column>`). The masked views `support.v_<table>` in migration 0017 are generated
// from these definitions by maskedViewSql (views.test.ts fails when they drift). The ticket's captured
// `context` (route, selection, console errors) is confidential by default: an admin decides who reads it.

type FieldOptions = Omit<FieldDef, "name" | "type" | "label">;

function fieldsOf(entity: string) {
  return (name: string, type: FieldType, options: FieldOptions = {}): FieldDef => ({ name, type, label: `field.${entity}.${name}`, ...options });
}

/** Columns every company table of the module carries after its own (rule 7). */
const trailer = (f: ReturnType<typeof fieldsOf>): FieldDef[] => [
  f("extra", "json", { sortable: false }),
  f("extra_free", "json", { sortable: false }),
  f("created_at", "datetime"),
  f("updated_at", "datetime"),
];

export const TICKET_KINDS = ["bug", "question", "request"] as const;
export const TICKET_STATUSES = ["open", "answered", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high"] as const;

const ticketFields = fieldsOf("support.ticket");
export const ticket: EntityDef = {
  id: "support.ticket",
  module: "support",
  schema: "support",
  table: "tickets",
  label: "entity.support.ticket",
  displayField: "title",
  defaultSort: { field: "seq", dir: "desc" },
  fields: [
    ticketFields("seq", "number", { required: true }),
    ticketFields("reporter_user_id", "uuid", { required: true }),
    ticketFields("kind", "enum", { required: true, enumValues: [...TICKET_KINDS] }),
    ticketFields("title", "text", { required: true, searchable: true }),
    ticketFields("body", "text", { required: true, searchable: true, sortable: false }),
    ticketFields("context", "json", { sensitivity: "confidential", sortable: false }),
    ticketFields("status", "enum", { required: true, enumValues: [...TICKET_STATUSES] }),
    ticketFields("priority", "enum", { required: true, enumValues: [...TICKET_PRIORITIES] }),
    ...trailer(ticketFields),
  ],
  // Files on a ticket are attached by whoever may follow the conversation: the reporter and the agents both reply.
  processIds: { attach: "support.ticket.reply" },
};

const messageFields = fieldsOf("support.ticket_message");
export const ticketMessage: EntityDef = {
  id: "support.ticket_message",
  module: "support",
  schema: "support",
  table: "ticket_messages",
  label: "entity.support.ticket_message",
  displayField: "seq",
  defaultSort: { field: "seq", dir: "asc" },
  fields: [
    messageFields("seq", "number", { required: true }),
    messageFields("ticket_id", "ref", { required: true, ref: { entity: "support.ticket", display: "title" } }),
    messageFields("author_user_id", "uuid", { required: true }),
    messageFields("body", "text", { required: true, searchable: true, sortable: false }),
    messageFields("is_internal", "boolean", { required: true }),
    ...trailer(messageFields),
  ],
};

export const SUPPORT_ENTITIES: EntityDef[] = [ticket, ticketMessage];
