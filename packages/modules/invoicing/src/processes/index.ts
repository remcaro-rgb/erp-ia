import { PAYMENT_PROCESSES } from "../consumers/payments";
import { AUTO_PROCESSES } from "./auto";
import { EINVOICE_PROCESSES } from "./einvoice";
import { INVOICE_PROCESSES } from "./invoice";
import { NOTE_PROCESSES } from "./note";
import { PENDING_PROCESSES } from "./pending";
import { SETTINGS_PROCESSES } from "./settings";

export const INVOICING_PROCESSES = [...INVOICE_PROCESSES, ...NOTE_PROCESSES, ...AUTO_PROCESSES, ...EINVOICE_PROCESSES, ...SETTINGS_PROCESSES, ...PENDING_PROCESSES, ...PAYMENT_PROCESSES];
