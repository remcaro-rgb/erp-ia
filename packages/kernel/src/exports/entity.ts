import { defineEntity } from "../registry/entities";

/**
 * An export job (design §9): one row per export that outgrew the inline path and runs as a Workflow, with its status,
 * its row count and where the file lives. Read through `kernel.v_export_jobs`, which only shows a member the jobs they
 * started (company admins see all). The grid state the job was asked for stays in the table (`state`), not in the view.
 */
export const exportJobEntity = defineEntity({
  id: "kernel.export_job",
  module: "kernel",
  schema: "kernel",
  table: "export_jobs",
  label: "entity.kernel.export_job",
  displayField: "file_name",
  defaultSort: { field: "created_at", dir: "desc" },
  fields: [
    { name: "entity", type: "text", label: "field.kernel.export_job.entity", required: true },
    { name: "format", type: "enum", label: "field.kernel.export_job.format", required: true, enumValues: ["csv", "xlsx", "pdf"] },
    { name: "status", type: "enum", label: "field.kernel.export_job.status", required: true, enumValues: ["queued", "running", "done", "failed"] },
    { name: "row_count", type: "number", label: "field.kernel.export_job.row_count" },
    { name: "file_name", type: "text", label: "field.kernel.export_job.file_name" },
    { name: "storage_path", type: "text", label: "field.kernel.export_job.storage_path" },
    { name: "error", type: "text", label: "field.kernel.export_job.error" },
    { name: "user_id", type: "uuid", label: "field.kernel.export_job.user_id" },
    { name: "finished_at", type: "datetime", label: "field.kernel.export_job.finished_at" },
    { name: "created_at", type: "datetime", label: "field.kernel.export_job.created_at" },
    { name: "updated_at", type: "datetime", label: "field.kernel.export_job.updated_at" },
  ],
});
