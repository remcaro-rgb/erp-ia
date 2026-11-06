import { countryPack, customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { cashBoxEntity, METHOD_KINDS, methodEntity } from "../entities";
import { assertWritable, defined, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, maestroLifecycle, refuse, refuseDuplicate, rejectErrors } from "./common";

// Medios de pago and cajas (plan 2B Task 21): maestros (entity types spec §2.2) created Grabado (Pendiente de Aprobación when the company
// requires it), Activo is `is_active`; a recibo names only a usable one (the lifecycle's gate). Codes are unique per company whatever their
// case, among the records not deleted. A method's KIND is the dimension its receipts' cash line resolves the account by
// (`payment_method:<kind>`): the Colombia pack maps cash, transfer, card and check; a receipt of a kind the pack does not map (other) is
// refused. Its DIAN payment means code (table 13.3.4.2) must be known to the country pack and fit the kind (rule 5).

export const FEATURE_METHODS = "payments.methods";

const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/, "El código lleva de 1 a 20 letras, números, punto, guion o guion bajo");
const name = z.string().trim().min(1).max(120);

const methodFields = {
  code,
  name,
  kind: z.enum(METHOD_KINDS),
  meansCode: z.string().trim().min(1).max(5).optional(),
  isActive: z.boolean(),
};
const METHOD_KEY = "methods_company_code_key";
const METHOD_WRITABLE = ["code", "name", "kind", "means_code", "is_active", "extra", "extra_free"];

const boxFields = { code, name, description: z.string().trim().max(300).optional(), isActive: z.boolean() };
const BOX_KEY = "cash_boxes_company_code_key";
const BOX_WRITABLE = ["code", "name", "description", "is_active", "extra", "extra_free"];

const methodColumns = (input: Partial<z.output<z.ZodObject<typeof methodFields>>>) =>
  defined({ code: input.code, name: input.name, kind: input.kind, means_code: input.meansCode, is_active: input.isActive });
const boxColumns = (input: Partial<z.output<z.ZodObject<typeof boxFields>>>) =>
  defined({ code: input.code, name: input.name, description: input.description, is_active: input.isActive });

/**
 * The DIAN payment means code must be one the country pack knows and fit the method's kind (rule 5: the pack's paymentMeansByKind, e.g. a
 * transferencia is 42 or 47, never 10 efectivo); a pack without e-invoicing cannot check it, so none is kept.
 */
async function assertMeansCode(ctx: ProcessContext, means: string | null | undefined, kind: string): Promise<void> {
  if (means === undefined || means === null) return;
  const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
  const einvoice = countryPack(company!.country_code).einvoice;
  const known = einvoice?.paymentMeans;
  if (!known) refuse("invalid_means_code", ["El paquete del país no tiene los medios de pago de la DIAN: deja el código vacío"]);
  if (!known.includes(means)) refuse("invalid_means_code", [`El medio de pago ${means} no es un código DIAN aceptado`]);
  const fitting = einvoice?.paymentMeansByKind?.[kind];
  if (fitting && !fitting.includes(means)) {
    refuse("means_code_kind_mismatch", [`El código DIAN ${means} no corresponde a un medio de tipo ${KIND_NAMES[kind] ?? kind}: usa ${fitting.join(", ")}`]);
  }
}

const KIND_NAMES: Record<string, string> = { cash: "efectivo", transfer: "transferencia", card: "tarjeta", check: "cheque", other: "otro" };

/** The validated extra data to write (custom fields of the company), or undefined when the request does not touch it. */
async function validExtra(ctx: ProcessContext, entityId: string, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined): Promise<{ value: Record<string, unknown> } | undefined> {
  const custom = await customData(ctx, entityId, stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? undefined : { value: custom.extra as Record<string, unknown> };
}

const extraColumn = (ctx: ProcessContext, extraValue: { value: Record<string, unknown> } | undefined) =>
  extraValue ? { extra: ctx.tx.json(extraValue.value as Parameters<typeof ctx.tx.json>[0]) } : {};

export const methodCreate = defineProcess({
  id: "payments.method.create",
  module: "payments",
  kind: "create",
  feature: FEATURE_METHODS,
  description: "Crea un medio de pago (efectivo, transferencia, tarjeta, cheque u otro) con su código, que define la cuenta de caja o bancos de sus recibos, y su código DIAN",
  input: z.object({ ...methodFields, isActive: methodFields.isActive.default(true), extra }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await assertMeansCode(ctx, input.meansCode, input.kind);
    const extraJson = await validExtra(ctx, methodEntity.id, "payments.method.create", null, input.extra);
    const state = await initialLifecycle(ctx, methodEntity.id);
    const [row] = await refuseDuplicate("payments.method.create", METHOD_KEY, `Ya existe un medio de pago con el código ${input.code}`, () =>
      ctx.tx<{ id: string }[]>`
        insert into payments.methods ${ctx.tx({ company_id: ctx.companyId, ...methodColumns(input), ...extraColumn(ctx, extraJson), ...state })}
        returning id`,
    );
    return { id: row!.id };
  },
});

export const methodUpdate = defineProcess({
  id: "payments.method.update",
  module: "payments",
  kind: "update",
  feature: FEATURE_METHODS,
  description: "Actualiza un medio de pago: código, nombre, tipo, código DIAN y si está activo",
  input: z.object(methodFields).partial().extend({ id, meansCode: methodFields.meansCode.nullable(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: methodId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from payments.methods where id = ${methodId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `payment method ${methodId} not found`);
    // The code and the kind as they will stand: a new kind is checked against the stored code and a new code against the stored kind.
    const means = input.meansCode !== undefined ? input.meansCode : (current.means_code as string | null);
    await assertMeansCode(ctx, means, input.kind ?? (current.kind as string));
    const extraJson = await validExtra(ctx, methodEntity.id, "payments.method.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...methodColumns({ ...input, meansCode: undefined }), ...(input.meansCode !== undefined ? { means_code: input.meansCode } : {}), ...extraColumn(ctx, extraJson) };
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("payments.method.update", METHOD_KEY, `Ya existe un medio de pago con el código ${input.code ?? ""}`, () =>
        ctx.tx`update payments.methods set ${ctx.tx(set)} where id = ${methodId}`,
      );
    }
    await followLifecycle(ctx, methodEntity.id, methodId, current);
    return { id: methodId };
  },
});

export const methodConsult = defineProcess({
  id: "payments.method.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_METHODS,
  description: "Consulta un medio de pago con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: methodId }) => {
    const [row] = await ctx.tx`select * from payments.v_methods where id = ${methodId}`;
    if (!row) throw new ProcessError("not_found", `payment method ${methodId} not found`);
    return { ...row, id: methodId, extra: await visibleExtra(ctx, methodEntity.id, row.extra) };
  },
});

export const cashBoxCreate = defineProcess({
  id: "payments.cash_box.create",
  module: "payments",
  kind: "create",
  feature: FEATURE_METHODS,
  description: "Crea una caja donde se recibe efectivo, con su código y nombre",
  input: z.object({ ...boxFields, isActive: boxFields.isActive.default(true), extra }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const extraJson = await validExtra(ctx, cashBoxEntity.id, "payments.cash_box.create", null, input.extra);
    const state = await initialLifecycle(ctx, cashBoxEntity.id);
    const [row] = await refuseDuplicate("payments.cash_box.create", BOX_KEY, `Ya existe una caja con el código ${input.code}`, () =>
      ctx.tx<{ id: string }[]>`
        insert into payments.cash_boxes ${ctx.tx({ company_id: ctx.companyId, ...boxColumns(input), ...extraColumn(ctx, extraJson), ...state })}
        returning id`,
    );
    return { id: row!.id };
  },
});

export const cashBoxUpdate = defineProcess({
  id: "payments.cash_box.update",
  module: "payments",
  kind: "update",
  feature: FEATURE_METHODS,
  description: "Actualiza una caja: código, nombre, descripción y si está activa",
  input: z.object(boxFields).partial().extend({ id, extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: boxId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from payments.cash_boxes where id = ${boxId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `cash box ${boxId} not found`);
    const extraJson = await validExtra(ctx, cashBoxEntity.id, "payments.cash_box.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...boxColumns(input), ...extraColumn(ctx, extraJson) };
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("payments.cash_box.update", BOX_KEY, `Ya existe una caja con el código ${input.code ?? ""}`, () =>
        ctx.tx`update payments.cash_boxes set ${ctx.tx(set)} where id = ${boxId}`,
      );
    }
    await followLifecycle(ctx, cashBoxEntity.id, boxId, current);
    return { id: boxId };
  },
});

export const cashBoxConsult = defineProcess({
  id: "payments.cash_box.consult",
  module: "payments",
  kind: "consult",
  feature: FEATURE_METHODS,
  description: "Consulta una caja con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: boxId }) => {
    const [row] = await ctx.tx`select * from payments.v_cash_boxes where id = ${boxId}`;
    if (!row) throw new ProcessError("not_found", `cash box ${boxId} not found`);
    return { ...row, id: boxId, extra: await visibleExtra(ctx, cashBoxEntity.id, row.extra) };
  },
});

/** The validate hook of a medio de pago (Grabar, Aprobar): the stored record passes the create schema, the pack's code and the custom fields. */
export const methodHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `payments.method.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, METHOD_WRITABLE);
    const parsed = z.object(methodFields).safeParse({ code: record.code, name: record.name, kind: record.kind, meansCode: record.means_code ?? undefined, isActive: record.is_active });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    await assertMeansCode(ctx, (record.means_code as string | null) ?? null, record.kind as string);
    const custom = await customData(ctx, methodEntity.id, record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

/** The validate hook of a caja (Grabar, Aprobar). */
export const cashBoxHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `payments.cash_box.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, BOX_WRITABLE);
    const parsed = z.object(boxFields).safeParse({ code: record.code, name: record.name, description: record.description ?? undefined, isActive: record.is_active });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, cashBoxEntity.id, record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const MASTER_PROCESSES = [
  methodCreate, methodUpdate, methodConsult, cashBoxCreate, cashBoxUpdate, cashBoxConsult,
  ...maestroLifecycle(methodEntity, FEATURE_METHODS, { constraint: METHOD_KEY, detail: "Ya existe un medio de pago con ese código" }),
  ...maestroLifecycle(cashBoxEntity, FEATURE_METHODS, { constraint: BOX_KEY, detail: "Ya existe una caja con ese código" }),
];
