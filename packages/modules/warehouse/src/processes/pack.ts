import { defineProcess, ProcessError, runLifecycle, writeSnapshot, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { packEntity, type PackStage } from "../entities";
import { id, num, qtyText, quantity, refuse, refuseState, round4 } from "./common";

// Empaques (plan 2B.2 Task 29.3, PG §4.3 step 6; owner item 154). An empaque is a documento numbered EMP- on save that never posts: the
// packages a confirmed alistamiento leaves in. warehouse.pack.create makes it from the alistamiento (one empaque not voided per
// alistamiento; asked again, it answers that one) with one package holding everything picked; warehouse.pack.update rewrites the packages
// by hand (number, weight in kg, dimensions, and how much of each picked line goes in each: never more than was picked of a line,
// `pack_exceeds_pick`); warehouse.pack.close packs it (its packages no longer change, 0172's trigger); warehouse.pack.void annuls it. The
// «Lista de empaque» is its print (print.ts). Packing gates nothing: the entrega of the alistamiento is made and shipped whatever the
// empaque's state (RG-8: sales acts on inventory's allocation, never on warehouse documents).

const FEATURE = "warehouse.packing";
const NUMBER_PREFIX = "EMP-";
/** What Grabar may change of an empaque (its packages change through update). */
const WRITABLE = ["notes", "extra", "extra_free"];

interface PackRow {
  id: string; number: string | null; status: string; stage: PackStage; pick_id: string; packages_count: number; total_weight_kg: string | null;
}
interface PackageRow { id: string; package_no: number; weight_kg: string | null; dimensions: string | null; items: { pickLineId: string; qty: number }[]; contents: string | null }
/** A line of the alistamiento as the empaque reads it: what was picked, of which product, lot and serial. */
interface PickedLine { id: string; line_no: number; product_id: string; lot_id: string | null; serial_id: string | null; qty_picked: string | null }

const packageOutput = z.object({
  id: z.string(), packageNo: z.number(), weightKg: z.number().nullable(), dimensions: z.string().nullable(),
  lines: z.array(z.object({ pickLineId: z.string(), qty: z.number() })), contents: z.string().nullable(),
});
const packOutput = z.object({
  id: z.string(), number: z.string().nullable(), status: z.string(), stage: z.string(), pickId: z.string(), packagesCount: z.number(),
  totalWeightKg: z.number().nullable(), packages: z.array(packageOutput),
});
type PackOutput = z.output<typeof packOutput>;

const label = (p: Pick<PackRow, "number" | "id">) => p.number ?? p.id;

async function outputOf(ctx: ProcessContext, packId: string): Promise<PackOutput> {
  const [row] = await ctx.tx<PackRow[]>`select id, number, status, stage, pick_id, packages_count, total_weight_kg::text from warehouse.packs where id = ${packId}`;
  if (!row) throw new ProcessError("not_found", `pack ${packId} not found`);
  const packages = await ctx.tx<PackageRow[]>`
    select id, package_no, weight_kg::text, dimensions, items, contents from warehouse.pack_packages where pack_id = ${packId} order by package_no`;
  return {
    id: row.id, number: row.number, status: row.status, stage: row.stage, pickId: row.pick_id, packagesCount: row.packages_count,
    totalWeightKg: row.total_weight_kg === null ? null : num(row.total_weight_kg),
    packages: packages.map((p) => ({
      id: p.id, packageNo: p.package_no, weightKg: p.weight_kg === null ? null : num(p.weight_kg), dimensions: p.dimensions,
      lines: p.items.map((i) => ({ pickLineId: i.pickLineId, qty: num(i.qty) })), contents: p.contents,
    })),
  };
}

async function lockPack(ctx: ProcessContext, packId: string): Promise<PackRow> {
  const [row] = await ctx.tx<PackRow[]>`select id, number, status, stage, pick_id, packages_count, total_weight_kg::text from warehouse.packs where id = ${packId} for update`;
  if (!row) throw new ProcessError("not_found", `pack ${packId} not found`);
  return row;
}

/** Refuses a change of an empaque that is voided or closed. */
function assertOpen(pack: PackRow): void {
  if (pack.status === "voided") refuseState("pack_voided", [`El empaque ${label(pack)} está anulado`]);
  if (pack.stage === "closed") refuseState("pack_closed", [`El empaque ${label(pack)} está cerrado: sus paquetes no cambian`]);
}

/** Refuses a change of an empaque whose alistamiento was voided (its pedido cancelled): what it packs is no longer to ship. */
async function assertPickLive(ctx: ProcessContext, pack: PackRow): Promise<void> {
  const [pick] = await ctx.tx<{ number: string | null; status: string }[]>`select number, status from warehouse.picks where id = ${pack.pick_id}`;
  if (pick?.status === "voided") refuseState("pick_voided", [`El alistamiento ${pick.number ?? pack.pick_id} del empaque ${label(pack)} está anulado`]);
}

/** The lines of the alistamiento that were picked (quantity > 0), in its order. */
const pickedLines = async (ctx: ProcessContext, pickId: string): Promise<PickedLine[]> =>
  (await ctx.tx<PickedLine[]>`
    select id, line_no, product_id, lot_id, serial_id, qty_picked::text from warehouse.pick_lines where pick_id = ${pickId} order by line_no`)
    .filter((l) => num(l.qty_picked) > 0);

const packageInput = z.object({
  packageNo: z.number().int().min(1).max(9999),
  weightKg: quantity.optional(),
  dimensions: z.string().trim().min(1).max(100).optional(),
  lines: z.array(z.object({ pickLineId: id, qty: quantity.refine((n) => n > 0, "La cantidad debe ser mayor que cero") }).strict()).max(500),
}).strict();
type PackageInput = z.output<typeof packageInput>;

/**
 * Checks the packages against the alistamiento (a package number once, `duplicate_package`; a line of the alistamiento that was picked,
 * `invalid_pick_line`; never more of a line than was picked, `pack_exceeds_pick`) and writes them over the empaque's packages, with their
 * contents in words (product, lot or serial, quantity, read through inventory's and core's published views) and the empaque's count and weight.
 */
async function writePackages(ctx: ProcessContext, pack: PackRow, packages: PackageInput[]): Promise<void> {
  const numbers = packages.map((p) => p.packageNo);
  const twice = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
  if (twice.length > 0) refuse("duplicate_package", twice.map((n) => `El paquete ${n} aparece dos veces`));
  const lines = await pickedLines(ctx, pack.pick_id);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const unknown = packages.flatMap((p) => p.lines.filter((l) => !byId.has(l.pickLineId)).map((l) => `Paquete ${p.packageNo}: la línea ${l.pickLineId} no es una línea tomada de este alistamiento`));
  if (unknown.length > 0) refuse("invalid_pick_line", unknown);
  const packed = new Map<string, number>();
  for (const p of packages) for (const l of p.lines) packed.set(l.pickLineId, round4((packed.get(l.pickLineId) ?? 0) + l.qty));
  const over = [...packed].filter(([lineId, qty]) => qty > num(byId.get(lineId)!.qty_picked));
  if (over.length > 0) {
    refuse("pack_exceeds_pick", over.map(([lineId, qty]) => {
      const line = byId.get(lineId)!;
      return `Línea ${line.line_no} del alistamiento: se tomaron ${qtyText(num(line.qty_picked))} y se empacan ${qtyText(qty)}`;
    }));
  }

  const products = [...new Set(lines.map((l) => l.product_id))];
  const lotIds = [...new Set(lines.flatMap((l) => (l.lot_id ? [l.lot_id] : [])))];
  const serialIds = [...new Set(lines.flatMap((l) => (l.serial_id ? [l.serial_id] : [])))];
  // The SKU only (the print shows one line per cell: a package with the descriptions too would clip; owner item 236).
  const names = new Map((await ctx.tx<{ id: string; sku: string | null; description: string | null }[]>`
    select id, sku, description from core.v_products where id = any(${products}::uuid[])`).map((p) => [p.id, p.sku ?? p.description ?? p.id]));
  const lots = new Map((lotIds.length === 0 ? [] : await ctx.tx<{ id: string; code: string | null }[]>`
    select id, code from inventory.v_lots where id = any(${lotIds}::uuid[])`).map((l) => [l.id, l.code]));
  const serials = new Map((serialIds.length === 0 ? [] : await ctx.tx<{ id: string; serial_no: string | null }[]>`
    select id, serial_no from inventory.v_serials where id = any(${serialIds}::uuid[])`).map((s) => [s.id, s.serial_no]));
  const contents = (p: PackageInput) => p.lines.map((l) => {
    const line = byId.get(l.pickLineId)!;
    const lot = line.lot_id ? `Lote ${lots.get(line.lot_id) ?? ""}` : line.serial_id ? `Serie ${serials.get(line.serial_id) ?? ""}` : null;
    return [names.get(line.product_id) ?? line.product_id, lot, qtyText(l.qty)].filter(Boolean).join(" · ");
  }).join("; ").slice(0, 4000) || null;

  await ctx.tx`delete from warehouse.pack_packages where pack_id = ${pack.id}`;
  if (packages.length > 0) {
    await ctx.tx`insert into warehouse.pack_packages ${ctx.tx(packages.map((p) => ({
      company_id: ctx.companyId, pack_id: pack.id, package_no: p.packageNo, weight_kg: p.weightKg ?? null, dimensions: p.dimensions ?? null,
      items: ctx.tx.json(p.lines.map((l) => ({ pickLineId: l.pickLineId, qty: l.qty })) as never), contents: contents(p),
    })))}`;
  }
  const weights = packages.flatMap((p) => (p.weightKg === undefined ? [] : [p.weightKg]));
  await ctx.tx`
    update warehouse.packs set packages_count = ${packages.length}, total_weight_kg = ${weights.length === 0 ? null : round4(weights.reduce((s, w) => s + w, 0))}
    where id = ${pack.id}`;
}

const createOutput = packOutput.extend({
  created: z.boolean(),
  /** Why nothing was created: the alistamiento already has an empaque not voided (it is answered). */
  reason: z.enum(["pack_exists"]).optional(),
});

export const packCreate = defineProcess({
  id: "warehouse.pack.create",
  module: "warehouse",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  description:
    "Crea el empaque de un alistamiento confirmado, con un paquete que lleva todo lo tomado; si el alistamiento ya tiene un empaque, lo devuelve. El empaque no condiciona la entrega",
  input: z.object({ pickId: id }).strict(),
  output: createOutput,
  handler: async (ctx, { pickId }) => {
    // One run at a time per alistamiento: the second sees the first's empaque.
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`warehouse.pack:${ctx.companyId}:${pickId}`}, 0))`;
    const [pick] = await ctx.tx<{ id: string; number: string | null; status: string; stage: string; order_id: string; order_number: string | null; warehouse_id: string; party_id: string }[]>`
      select id, number, status, stage, order_id, order_number, warehouse_id, party_id from warehouse.picks where id = ${pickId}`;
    if (!pick) throw new ProcessError("not_found", `pick ${pickId} not found`);
    const pickLabel = pick.number ?? pick.id;
    if (pick.status === "voided") refuseState("pick_voided", [`El alistamiento ${pickLabel} está anulado`]);
    if (pick.stage !== "confirmed") refuseState("pick_not_confirmed", [`El alistamiento ${pickLabel} no está confirmado: se empaca lo que se tomó`]);
    const [existing] = await ctx.tx<{ id: string }[]>`select id from warehouse.packs where company_id = ${ctx.companyId} and pick_id = ${pickId} and status <> 'voided' limit 1`;
    if (existing) return { ...(await outputOf(ctx, existing.id)), created: false, reason: "pack_exists" as const };
    const lines = await pickedLines(ctx, pickId);
    if (lines.length === 0) refuseState("nothing_picked", [`El alistamiento ${pickLabel} no tiene nada tomado`]);

    const [header] = await ctx.tx<PackRow[]>`
      insert into warehouse.packs ${ctx.tx({
        company_id: ctx.companyId,
        pick_id: pick.id,
        pick_number: pick.number,
        order_id: pick.order_id,
        order_number: pick.order_number,
        warehouse_id: pick.warehouse_id,
        party_id: pick.party_id,
        stage: "open",
        // An empaque neither waits for approval nor posts (ownFlags).
        requires_approval: false,
        posts: false,
      })}
      returning id, number, status, stage, pick_id, packages_count, total_weight_kg::text`;
    await writePackages(ctx, header!, [{ packageNo: 1, lines: lines.map((l) => ({ pickLineId: l.id, qty: num(l.qty_picked) })) }]);
    await runLifecycle(ctx, ctx.registry.entity(packEntity.id), header!.id, "save");
    return { ...(await outputOf(ctx, header!.id)), created: true };
  },
});

export const packUpdate = defineProcess({
  id: "warehouse.pack.update",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description:
    "Cambia los paquetes de un empaque abierto (número, peso en kg, medidas y qué lleva cada uno de las líneas tomadas) y sus notas; nunca se empaca más de lo tomado",
  input: z.object({
    id,
    notes: z.string().trim().max(2000).nullable().optional(),
    packages: z.array(packageInput).max(200).optional(),
  }).strict(),
  output: packOutput,
  handler: async (ctx, input) => {
    const pack = await lockPack(ctx, input.id);
    assertOpen(pack);
    await assertPickLive(ctx, pack);
    if (input.packages) await writePackages(ctx, pack, input.packages);
    if (input.notes !== undefined) await ctx.tx`update warehouse.packs set notes = ${input.notes} where id = ${pack.id}`;
    return outputOf(ctx, pack.id);
  },
});

export const packClose = defineProcess({
  id: "warehouse.pack.close",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description: "Cierra un empaque: lo empacado queda así y sus paquetes ya no cambian (el empaque no condiciona la entrega)",
  input: z.object({ id }).strict(),
  output: packOutput,
  handler: async (ctx, input) => {
    const pack = await lockPack(ctx, input.id);
    assertOpen(pack);
    await assertPickLive(ctx, pack);
    const [content] = await ctx.tx<{ n: number }[]>`
      select count(*)::int as n from warehouse.pack_packages where pack_id = ${pack.id} and jsonb_array_length(items) > 0`;
    if (!content || content.n === 0) refuseState("pack_empty", [`El empaque ${label(pack)} no tiene nada empacado`]);
    await ctx.tx`update warehouse.packs set stage = 'closed', closed_at = now() where id = ${pack.id}`;
    // A change past Borrador keeps its version (entity types spec §8).
    await writeSnapshot(ctx, ctx.registry.entity(packEntity.id), pack.id, pack.status as never, null);
    return outputOf(ctx, pack.id);
  },
});

export const packVoid = defineProcess({
  id: "warehouse.pack.void",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description: "Anula un empaque, abierto o cerrado, con el motivo; el alistamiento y su entrega no cambian",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), expectedUpdatedAt: z.string().optional() }).strict(),
  output: packOutput,
  handler: async (ctx, input) => {
    const pack = await lockPack(ctx, input.id);
    if (pack.status === "voided") refuseState("pack_voided", [`El empaque ${label(pack)} ya está anulado`]);
    await runLifecycle(ctx, ctx.registry.entity(packEntity.id), pack.id, "void", { reason: input.reason, ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) });
    return outputOf(ctx, pack.id);
  },
});

export const packConsult = defineProcess({
  id: "warehouse.pack.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un empaque con sus paquetes y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), packages: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: packId }) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_packs where id = ${packId}`;
    if (!row) throw new ProcessError("not_found", `pack ${packId} not found`);
    const packages = await ctx.tx<{ id: string }[]>`select * from warehouse.v_pack_packages where pack_id = ${packId} order by package_no`;
    return {
      ...row, id: packId, packages,
      packagesCount: row.packages_count === null || row.packages_count === undefined ? null : Number(row.packages_count),
      totalWeightKg: row.total_weight_kg === null || row.total_weight_kg === undefined ? null : Number(row.total_weight_kg),
    };
  },
});

export const packPackageConsult = defineProcess({
  id: "warehouse.pack_package.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un paquete de un empaque con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: packageId }) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_pack_packages where id = ${packageId}`;
    if (!row) throw new ProcessError("not_found", `pack package ${packageId} not found`);
    return { ...row, id: packageId };
  },
});

/**
 * The hooks of an empaque: Grabar changes only its notes and extra data (its packages change through update); the number is drawn on save
 * from the company counter (prefix EMP-).
 */
export const packHooks: TypedHooks = {
  async validate(_ctx, record, mode, { data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for warehouse.pack.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    if (record.status === "voided") refuseState("pack_voided", ["Un empaque anulado no cambia"]);
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select warehouse.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const PACK_PROCESSES = [packCreate, packUpdate, packClose, packVoid, packConsult, packPackageConsult];
