import { z } from "zod";
import { GridState } from "../query/grid-state";
import { EXPORT_PAGE_SIZE } from "../exports/types";

/**
 * The state a report's consult takes: a grid state whose window may be as large as an export reads
 * (`EXPORT_PAGE_SIZE`; a grid's own page stops at 500). Modules use it as the `state` of their consult input.
 */
export const ReportState = GridState.extend({ pageSize: z.number().int().min(1).max(EXPORT_PAGE_SIZE) });
export type ReportState = z.infer<typeof ReportState>;
