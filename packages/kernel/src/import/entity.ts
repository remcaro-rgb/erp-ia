import { defineEntity } from "../registry/entities";

/**
 * A mass import (design §5.11, §9): one row per file a user imported into an entity, with its counts. The source
 * file and `errores.csv` are attachments of this record, so attaching them requires `kernel.import.run` (the
 * process that creates the record) instead of an update process the import does not have.
 */
export const importEntity = defineEntity({
  id: "kernel.import",
  module: "kernel",
  schema: "kernel",
  table: "imports",
  label: "entity.kernel.import",
  displayField: "entity",
  defaultSort: { field: "created_at", dir: "desc" },
  processIds: { attach: "kernel.import.run" },
  fields: [
    { name: "entity", type: "text", label: "field.kernel.import.entity", required: true },
    { name: "status", type: "enum", label: "field.kernel.import.status", required: true, enumValues: ["queued", "running", "done", "failed"] },
    { name: "rows_total", type: "number", label: "field.kernel.import.rows_total" },
    { name: "rows_ok", type: "number", label: "field.kernel.import.rows_ok" },
    { name: "rows_failed", type: "number", label: "field.kernel.import.rows_failed" },
    { name: "file_attachment_id", type: "uuid", label: "field.kernel.import.file_attachment_id" },
    { name: "errors_attachment_id", type: "uuid", label: "field.kernel.import.errors_attachment_id" },
    { name: "started_by", type: "uuid", label: "field.kernel.import.started_by" },
    { name: "finished_at", type: "datetime", label: "field.kernel.import.finished_at" },
    { name: "error", type: "text", label: "field.kernel.import.error" },
    { name: "created_at", type: "datetime", label: "field.kernel.import.created_at" },
    { name: "updated_at", type: "datetime", label: "field.kernel.import.updated_at" },
  ],
});
