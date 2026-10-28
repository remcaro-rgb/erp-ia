export const KERNEL_VERSION = "0.1.0";
export { writeAudit, setAuditContext } from "./audit/audit";
export type { AuditAction, AuditContext, AuditEntry, Origin } from "./audit/audit";
export { enqueueEvent } from "./events/outbox";
export type { OutboxEvent } from "./events/outbox";
export type { Tx } from "./db/client";
export { defineEntity, Registry, registry } from "./registry";
export type { EntityDef, FieldDef, FieldType, ModuleDef, ProcessDef, ResolvedEntityDef, ResolvedFieldDef } from "./registry";
export { maskedViewSql } from "./security/masked-views";
