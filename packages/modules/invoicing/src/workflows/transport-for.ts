import { FatalError } from "workflow";
import type { EInvoiceTransport } from "@erp/infra";
import { countryPack, getServiceDb, installedEInvoiceTransport, secretStore } from "@erp/kernel";
import { DOCUMENT_ENVIRONMENT_MISSING } from "../document-environment";

// Moved out of einvoice.workflow.ts (Task 37, M1) so that it can be tested outside a run: a workflow file may export only workflows.
interface EInvoiceRunArgs { companyId: string; invoiceId: string; noteId?: string }

/**
 * Workflow-level transport: the installed override (tests) or the pack's, from configuration (the mock unless configured otherwise). Either
 * must serve the DIAN environment the document was issued in (Task 19; Task 37): the mock or habilitación never send the document of a company in producción, nor
 * the production transport a habilitación one. A mismatch stops the run before anything is sent (not retried: configuration, not network).
 */
export async function transportFor(args: EInvoiceRunArgs): Promise<EInvoiceTransport> {
  const companyId = args.companyId;
  const db = getServiceDb();
  // The document's environment, frozen at «Emitir» (Task 19 fix round 1), is the only source (Task 37, R37-2): never the company's current one.
  const [company] = await db<{ country_code: string; dian_environment: "habilitacion" | "produccion" | null }[]>`
    select c.country_code,
           ${args.noteId ? db`(select dian_environment from invoicing.notes where id = ${args.noteId})` : db`(select dian_environment from invoicing.invoices where id = ${args.invoiceId})`} as dian_environment
    from kernel.companies c where c.id = ${companyId}`;
  const einvoice = countryPack(company!.country_code).einvoice;
  if (!einvoice) throw new FatalError("einvoice_not_available: el paquete del país no tiene facturación electrónica registrada");
  const environment = company!.dian_environment;
  if (!environment) throw new FatalError(`document_environment_missing: ${DOCUMENT_ENVIRONMENT_MISSING}`);
  try {
    const installed = installedEInvoiceTransport();
    if (installed) {
      einvoice.assertTransportEnvironment(installed, environment);
      return installed;
    }
    return einvoice.transport({ secrets: secretStore(), companyId, environment });
  } catch (error) {
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
}

