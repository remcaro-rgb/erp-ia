import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { addRefLabels, gridPageAccess, GridState, refLabelKey, runGridQuery, runnableProcesses, withClaims, type Caller, type FieldMode, type GridStateInput } from "@erp/kernel";
import { formatDay, formatDayTime, formatMoney, type CodeOption, type LookupSource, type SalesFormKind } from "@erp/ui";
import { gridTab, type GridTab } from "@/lib/accounting/record-tabs";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { MASKED, moneyText } from "@/lib/records/masked";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { creditVisibleTo } from "@/lib/sales/credit";
import { partyTables } from "@/lib/records/tables";
import { processDeps } from "@/lib/server/runtime";
import { activeMembers, memberNames, readableOrderIds } from "./order-owner";

// What the Datos tab of a CRM or sales record needs besides the record (plan 2B Task 14b, prototype 2B), read as the caller: the lookup
// boxes' fields (customer, product, prospecto, oportunidad, the pedido or entrega a new entrega or devolución comes from), the bodegas
// a pedido offers and the embudos an oportunidad goes in; for a stored document its facts (references link to their records, rule 21), its
// totals in the money format (rule 23), its lines in the universal grid (rule 20) and the steps of its process the caller may run now. Every
// read goes through the masked views or the grid; the steps are an allowlist keyed by entity (`SALES_STEPS`): the server action picks the
// process from the entity and the step's name, never from the client.

/** The CRM and sales entities with a full record page, and their form. */
export const SALES_FORMS: Readonly<Record<string, SalesFormKind>> = {
  "crm.lead": "lead",
  "crm.pipeline": "pipeline",
  "crm.opportunity": "opportunity",
  "crm.activity": "activity",
  "crm.quote": "quote",
  "sales.order": "order",
  "sales.delivery": "delivery",
  "sales.return": "return",
};

/**
 * The steps a stored record's screen runs besides the bar's lifecycle buttons (Grabar, Aprobar, No aprobar, Anular are the bar's), by
 * entity and step name: the process each runs. `to_*` creates the next document of the chain and opens it.
 */
export const SALES_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "crm.quote": { send: "crm.quote.send", accept: "crm.quote.accept", expire: "crm.quote.expire", to_order: "sales.order.from_quote" },
  "sales.order": { confirm: "sales.order.confirm", cancel: "sales.order.cancel", to_delivery: "sales.delivery.create", reassign: "sales.order.reassign" },
  "sales.delivery": { ship: "sales.delivery.ship", to_return: "sales.return.create" },
  "sales.return": { receive: "sales.return.receive" },
  "crm.lead": { convert: "crm.lead.convert" },
  "crm.opportunity": { stage_move: "crm.opportunity.stage_move" },
};

/** A fact of a stored record's header: its label, its value as text and, for a reference, the record it links to (rule 21). */
export interface SalesFact {
  label: string;
  value: string;
  link?: { entity: string; id: string };
  mono?: boolean;
  testId?: string;
}

export interface SalesView {
  facts: SalesFact[];
  /** Subtotal, descuento, impuestos and total of a cotización or pedido, in the money format; null for the others. */
  totals: { subtotal: string; discount: string; tax: string; total: string } | null;
  /** The lines in the universal grid; null when the caller may not read them (or the record has none). */
  linesGrid: GridTab | null;
  /** The commercial stage (cotización, pedido, entrega, devolución, prospecto) or the outcome (oportunidad), and how it reads. */
  stage: string | null;
  stageLabel: string | null;
  /** The step names (`SALES_STEPS`) the caller may run now (rights ∩ stage ∩ status). */
  steps: string[];
  /** The documents that came from this one (a cotización's pedidos, a pedido's entregas, an entrega's devoluciones). */
  related: { label: string; items: { entity: string; id: string; number: string }[] } | null;
  /** An oportunidad's etapas (the Mover de etapa select) and the one it stands in. */
  stages: (CodeOption & { kind: string })[];
  stageId: string | null;
  /** A pedido's «Cambiar vendedor» (Task 39): the active members to hand it to and its current owner; null for the callers who may not run sales.order.reassign. */
  reassign: { members: CodeOption[]; ownerId: string | null } | null;
}

export interface SalesFormData {
  kind: "sales";
  sales: SalesFormKind;
  today: string;
  /** The bodegas a pedido (or an entrega) may take from (inventory's masked view, the transit bodega left out). */
  warehouses: CodeOption[];
  /** A prospecto's document types (the DIAN table of the country pack). */
  documentTypes: CodeOption[];
  /** The currencies a new cotización or pedido may be in (the company's, and those with a rate in Tasas de cambio or a price list; Task 34.3). */
  currencies: CodeOption[];
  companyCurrency: string;
  /** The embudos an oportunidad goes in. */
  pipelines: CodeOption[];
  party: LookupSource;
  product: LookupSource;
  lead: LookupSource | null;
  opportunity: LookupSource | null;
  /** The pedido (entrega) or entrega (devolución) box of a new one. */
  source: LookupSource | null;
  /** How the stored references read (`party_id`, `opportunity_id`). */
  labels: Record<string, string>;
  /** The stored lines of a cotización or pedido the caller may still edit, or an embudo's etapas. */
  lines: Record<string, unknown>[];
  /** A stored cotización or pedido the caller may still change through its update process. */
  editable: boolean;
  /** How the caller sees the fields of the lines (rule 14): with the price or discount masked, an open cotización's lines are not edited. */
  lineModes: Record<string, FieldMode>;
  /** A stored record's facts, lines and steps; null for a new one (and for an embudo, which edits in place). */
  view: SalesView | null;
}

type Row = Record<string, unknown> & { id: string };

const LINES: Record<string, { entity: string; parent: string }> = {
  "crm.quote": { entity: "crm.quote_line", parent: "quote_id" },
  "sales.order": { entity: "sales.order_line", parent: "order_id" },
  "sales.delivery": { entity: "sales.delivery_line", parent: "delivery_id" },
  "sales.return": { entity: "sales.return_line", parent: "return_id" },
  "crm.opportunity": { entity: "crm.opportunity_line", parent: "opportunity_id" },
};

/** The lifecycle statuses whose cotización or pedido lines may still change (entity types D3: Borrador, Grabado, No aprobado). */
const EDITABLE = new Set(["draft", "saved", "rejected"]);

/** Rows of an entity through the grid query, as the caller (its gate, RLS and masks); none when the caller may not read it. */
async function gridRows(caller: Caller, entityId: string, state: GridStateInput) {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity || (await gridDenial(deps, caller.claims, entity))) return { rows: [] as Row[], total: 0 };
  return runGridQuery(deps.sql, caller.claims, entity, GridState.parse(state));
}

/** The fields of an entity's lookup box as the caller sees them; null when the caller may not read the entity. */
async function lookupSource(caller: Caller, entityId: string): Promise<LookupSource | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity) return null;
  const [access, t, linkable] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), getTranslations(), linkableEntities(deps, caller.claims, [entityId])]);
  return { fields: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)), entityLabel: t(entity.label), linkable: linkable.has(entityId) };
}

/** The Datos tab's data of a CRM or sales record. */
export async function loadSalesForm(caller: Caller, entityId: string, record: Row | null): Promise<SalesFormData> {
  const deps = processDeps();
  const kind = SALES_FORMS[entityId]!;
  const t = await getTranslations();
  const locale = await getLocale();
  const needsParty = kind !== "pipeline";
  const [lists, party, product, lead, opportunity, source, runnable] = await Promise.all([
    withClaims(deps.sql, caller.claims, async (tx) => {
      const [today] = await tx<{ today: string; currency: string }[]>`select (now() at time zone timezone)::date::text as today, currency_code as currency from kernel.companies where id = ${caller.claims.active_company_id}`;
      const currencies = kind === "quote" || kind === "order" ? await tx<{ code: string; name: string }[]>`select distinct trim(c) as code, trim(c) as name from (
              select ${(today?.currency ?? "COP")}::text as c union all select currency from core.v_exchange_rates where currency is not null
              union all select currency_code from core.v_price_lists where currency_code is not null) t order by 1` : [];
      const warehouses =
        kind === "quote" || kind === "order" || kind === "delivery"
          ? await tx<{ id: string; code: string | null; name: string | null }[]>`
              select w.id, w.code, w.name from inventory.v_warehouses w
              where coalesce(w.is_active, true) and w.status in ('saved', 'approved')
                and not exists (select 1 from inventory.v_locations l where l.warehouse_id = w.id and l.kind = 'transit')
              order by w.code`
          : [];
      const pipelines =
        kind === "opportunity"
          ? await tx<{ id: string; code: string | null; name: string | null }[]>`
              select id, code, name from crm.v_pipelines where coalesce(is_active, true) and status in ('saved', 'approved') order by is_default desc, code`
          : [];
      return { today: today?.today ?? new Date().toISOString().slice(0, 10), companyCurrency: (today?.currency ?? "COP").trim(), currencies, warehouses, pipelines };
    }),
    needsParty ? lookupSource(caller, "core.party") : Promise.resolve(null),
    kind === "quote" || kind === "order" || kind === "opportunity" ? lookupSource(caller, "core.product") : Promise.resolve(null),
    kind === "opportunity" || kind === "activity" ? lookupSource(caller, "crm.lead") : Promise.resolve(null),
    kind === "quote" || kind === "activity" ? lookupSource(caller, "crm.opportunity") : Promise.resolve(null),
    kind === "delivery" ? lookupSource(caller, "sales.order") : kind === "return" ? lookupSource(caller, "sales.delivery") : Promise.resolve(null),
    runnableProcesses(deps.sql, deps.registry, caller.claims, entityId === "crm.quote" ? ["crm.quote.update"] : entityId === "sales.order" ? ["sales.order.update"] : []),
  ]);
  const entity = deps.registry.entity(entityId);
  const labels: Record<string, string> = {};
  if (record) {
    const header: Record<string, unknown> = { ...record };
    await withClaims(deps.sql, caller.claims, (tx) => addRefLabels(tx, deps.registry, entity, [header]));
    for (const field of entity.fields) {
      const label = field.type === "ref" ? header[refLabelKey(field.name)] : undefined;
      if (typeof label === "string") labels[field.name] = label;
    }
  }
  const stage = typeof record?.stage === "string" ? record.stage : null;
  const status = typeof record?.status === "string" ? record.status : null;
  const editable =
    record !== null &&
    (kind === "quote" || kind === "order") &&
    stage === "open" &&
    status !== null &&
    EDITABLE.has(status) &&
    runnable.has(kind === "quote" ? "crm.quote.update" : "sales.order.update");
  // The stored lines the edit form starts from (a cotización or pedido still open), or the etapas of an embudo, through the grid.
  let lines: Record<string, unknown>[] = [];
  let lineModes: Record<string, FieldMode> = {};
  if (record && editable) {
    const l = LINES[entityId]!;
    const lineEntity = gridEntity(deps.registry, l.entity);
    if (lineEntity) lineModes = { ...(await gridPageAccess(deps.sql, caller.claims, lineEntity)).modes };
    const page = await gridRows(caller, l.entity, { filters: [{ field: l.parent, op: "eq", value: record.id }], sort: [{ field: "line_no", dir: "asc" }], page: 1, pageSize: 500 });
    lines = page.rows.map((r) => ({ ...r, product_label: r[refLabelKey("product_id")] ?? r.product_id }));
  } else if (record && kind === "pipeline") {
    const page = await gridRows(caller, "crm.stage", { filters: [{ field: "pipeline_id", op: "eq", value: record.id }], sort: [{ field: "line_no", dir: "asc" }], page: 1, pageSize: 100 });
    lines = page.rows;
  }
  const view = record && kind !== "pipeline" ? await salesView(caller, entityId, record) : null;
  return {
    kind: "sales",
    sales: kind,
    today: lists.today,
    warehouses: lists.warehouses.map((w) => ({ code: w.id, name: [w.code, w.name].filter(Boolean).join(" · ") })),
    documentTypes: kind === "lead" ? partyTables(locale).documentTypes.map((d) => ({ code: d.code, name: d.name })) : [],
    currencies: lists.currencies.map((c) => ({ code: c.code, name: c.name })),
    companyCurrency: lists.companyCurrency,
    pipelines: lists.pipelines.map((p) => ({ code: p.id, name: [p.code, p.name].filter(Boolean).join(" · ") })),
    party: party ?? { fields: [], entityLabel: t("entity.core.party") },
    product: product ?? { fields: [], entityLabel: t("entity.core.product") },
    lead,
    opportunity,
    source,
    labels,
    lines,
    editable,
    lineModes,
    view,
  };
}


/** Whether a cotización's or pedido's lifecycle lets it go on (sent, accepted, confirmed): grabada, or approved when it needs approval. */
const goesOn = (record: Row) => (record.requires_approval === true ? record.status === "approved" : record.status === "saved" || record.status === "approved");

/** The facts, totals, lines and steps of a stored record. */
async function salesView(caller: Caller, entityId: string, record: Row): Promise<SalesView> {
  const deps = processDeps();
  const t = await getTranslations();
  const entity = deps.registry.entity(entityId);
  const lines = LINES[entityId];
  const steps = SALES_STEPS[entityId] ?? {};
  const header: Record<string, unknown> = { ...record };
  // A pedido's customer credit is shown only to who sees the credit limit unmasked (rule 14), may consult invoices (Task 20 fix round 1)
  // and sees every invoice amount the Disponible counts from invoicing's unmasked published views (final review I-2): hide rather than
  // be wrong or reveal a masked amount as the difference.
  const creditVisible = entityId === "sales.order" ? await creditVisibleTo(deps, caller.claims) : false;
  // The ids another module's record is named by (rule 3: no reference across schemas), read in its masked view as the caller.
  const named = await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    const [company] = await tx<{ timezone: string; currency: string | null }[]>`select timezone, currency_code as currency from kernel.companies where id = ${caller.claims.active_company_id}`;
    const warehouseId = entityId === "sales.order" && typeof record.warehouse_id === "string" ? record.warehouse_id : null;
    const [warehouse] = warehouseId ? await tx<{ code: string | null; name: string | null }[]>`select code, name from inventory.v_warehouses where id = ${warehouseId}` : [];
    const quoteId = entityId === "sales.order" && typeof record.quote_id === "string" ? record.quote_id : null;
    const [quote] = quoteId ? await tx<{ number: string | null }[]>`select number from crm.v_quotes where id = ${quoteId}` : [];
    const opportunityId = entityId === "sales.order" && typeof record.opportunity_id === "string" ? record.opportunity_id : null;
    const [deal] = opportunityId ? await tx<{ number: string | null }[]>`select number from crm.v_opportunities where id = ${opportunityId}` : [];
    // What came from it: a cotización's pedidos, a pedido's entregas, an entrega's devoluciones (the voided ones left out).
    const related =
      entityId === "crm.quote"
        ? await tx<{ id: string; number: string | null }[]>`select id, number from sales.v_orders where quote_id = ${record.id} and status <> 'voided' order by seq`
        : entityId === "sales.order"
          ? await tx<{ id: string; number: string | null }[]>`select id, number from sales.v_deliveries where order_id = ${record.id} and status <> 'voided' order by seq`
          : entityId === "sales.delivery"
            ? await tx<{ id: string; number: string | null }[]>`select id, number from sales.v_returns where delivery_id = ${record.id} and status <> 'voided' order by seq`
            : [];
    // The salesperson of a pedido (masked by field visibility, null for who may not see it) and of the pedido an entrega came from; whether the
    // pedido an entrega or devolución names is one the caller can read at all (a salesperson reads only their own pedidos, Task 39): else it
    // is «Pedido no disponible», never its number, its id or a link.
    const ownerIds = [record.owner_id, record.order_owner_id].filter((v): v is string => typeof v === "string");
    const owners = await memberNames(tx, ownerIds);
    const sourceOrder = (entityId === "sales.delivery" || entityId === "sales.return") && typeof record.order_id === "string" ? record.order_id : null;
    const orderReadable = sourceOrder ? (await readableOrderIds(tx, [sourceOrder])).has(sourceOrder) : true;
    const stages =
      entityId === "crm.opportunity" && typeof record.pipeline_id === "string"
        ? await tx<{ id: string; name: string | null; kind: string }[]>`select id, name, kind from crm.v_stages where pipeline_id = ${record.pipeline_id} order by line_no`
        : [];
    // A pedido's customer credit (prototype 2B: «Límite de crédito · Disponible $ …»): the limit as the caller sees it in the masked view of
    // the customer terms (an empty limit shows nothing), less what the customer already owes or has firmly ordered, as sales.credit_exposure
    // counts it since Task 16 (migration 0093): the firm pedidos (confirmed, partly or fully delivered) not yet invoiced (their total less
    // what issued invoices billed of them, never below zero) plus the issued invoices still open (total less paid and credited). Summed here
    // from the published views as the caller (rule 3: invoicing.v_order_invoiced and invoicing.v_open_invoices; rule 14: the pedidos' masked
    // view; the function is the processes', it locks and sees all). A pedido whose total the caller does not see hides the fact rather than
    // showing a wrong Disponible.
    let credit: { limit: number; available: number } | null = null;
    if (entityId === "sales.order" && typeof record.party_id === "string" && creditVisible) {
      const [terms] = await tx<{ credit_limit: string | null }[]>`select credit_limit::text from sales.v_customer_terms where party_id = ${record.party_id}`;
      if (terms && terms.credit_limit !== null && Number.isFinite(Number(terms.credit_limit))) {
        const [taken] = await tx<{ ordered: string; masked: number }[]>`
          select coalesce(sum(greatest(o.total_company - coalesce(oi.invoiced_company, 0), 0)), 0)::text as ordered,
                 count(*) filter (where o.total_company is null)::int as masked
          from sales.v_orders o left join invoicing.v_order_invoiced oi on oi.order_id = o.id
          where o.party_id = ${record.party_id} and o.stage in ('confirmed', 'partially_delivered', 'delivered') and o.status <> 'voided'`;
        const [open] = await tx<{ owed: string }[]>`select coalesce(sum(open_company), 0)::text as owed from invoicing.v_open_invoices where party_id = ${record.party_id}`;
        if (taken && taken.masked === 0) credit = { limit: Number(terms.credit_limit), available: Number(terms.credit_limit) - Number(taken.ordered) - Number(open?.owed ?? 0) };
      }
    }
    return {
      timeZone: company?.timezone,
      companyCurrency: company?.currency ?? null,
      credit,
      warehouse: warehouse ? [warehouse.code, warehouse.name].filter(Boolean).join(" · ") : null,
      quote: quote?.number ?? null,
      deal: deal?.number ?? null,
      related,
      stages,
      owners,
      orderReadable,
    };
  });
  const gridDef = gridEntity(deps.registry, entityId);
  const [linesGrid, runnable, linkable, access] = await Promise.all([
    lines ? gridTab(caller, lines.entity, [{ field: lines.parent, op: "eq", value: record.id }]) : Promise.resolve(null),
    runnableProcesses(deps.sql, deps.registry, caller.claims, Object.values(steps)),
    linkableEntities(deps, caller.claims, ["core.party", "crm.quote", "crm.opportunity", "crm.lead", "sales.order", "sales.delivery", "sales.return", "crm.pipeline", "inventory.warehouse"]),
    gridDef ? gridPageAccess(deps.sql, caller.claims, gridDef) : Promise.resolve(null),
  ]);
  // Rule 14 (Task 20 fix round 1): a field the role sees masked reads as the masked marker (never «$ 0,00» or a dropped fact).
  const modes: Record<string, FieldMode> = access?.modes ?? {};
  // The document's currency, else the company's (rule 8).
  const currency = typeof record.currency === "string" && record.currency ? record.currency : (named.companyCurrency ?? undefined);
  const companyMoney = (n: number) => formatMoney(n, named.companyCurrency ?? undefined);
  const label = (field: string) => {
    const def = entity.fields.find((f) => f.name === field);
    return def && t.has(def.label) ? t(def.label) : field;
  };
  const value = (field: string): string => {
    const def = entity.fields.find((f) => f.name === field);
    const raw = record[field];
    if (modes[field] === "hidden") return "—";
    if (modes[field] === "masked") return MASKED;
    if (raw === null || raw === undefined || raw === "") return "—";
    if (def?.type === "ref") return String(header[refLabelKey(field)] ?? raw);
    if (def?.valuesKey && typeof raw === "string" && t.has(`${def.valuesKey}.${raw}`)) return t(`${def.valuesKey}.${raw}`);
    // A calendar date reads AAAA/MM/DD (owner 2026-10-31): the driver gives it as UTC midnight.
    if (def?.type === "date") return raw instanceof Date ? formatDay(raw, "UTC") : String(raw).slice(0, 10).replaceAll("-", "/");
    if (def?.type === "datetime") return formatDayTime(raw instanceof Date ? raw.toISOString() : String(raw), named.timeZone);
    if (def?.type === "money") return formatMoney(Number(raw), currency);
    return String(raw);
  };
  const ref = (field: string, target: string, extra: Partial<SalesFact> = {}): SalesFact => {
    const raw = record[field];
    return { label: label(field), value: value(field), ...(typeof raw === "string" && linkable.has(target) ? { link: { entity: target, id: raw } } : {}), ...extra };
  };
  /** A reference held as a plain id (another module's record), named by what its masked view read. */
  const namedRef = (field: string, target: string, name: string | null): SalesFact => {
    const raw = record[field];
    if (typeof raw !== "string" || !raw) return { label: label(field), value: "—" };
    return { label: label(field), value: name ?? raw, mono: true, ...(name && linkable.has(target) ? { link: { entity: target, id: raw } } : {}) };
  };
  const plain = (field: string, extra: Partial<SalesFact> = {}): SalesFact => ({ label: label(field), value: value(field), ...extra });
  /** The pedido an entrega or devolución comes from: its link, or, when the caller cannot read it, plain text without number, id or link. */
  const orderRef = (): SalesFact =>
    named.orderReadable ? ref("order_id", "sales.order") : typeof record.order_id === "string" ? { label: label("order_id"), value: t("sales.view.order_unavailable"), testId: "order-unavailable" } : { label: label("order_id"), value: "—" };
  /** A salesperson (an owner uuid as a member's name, masked by field visibility; no owner reads «Sin vendedor» on the pedido itself). */
  const ownerFact = (field: string, testId: string): SalesFact => {
    const raw = record[field];
    if (modes[field] === "hidden") return { label: label(field), value: "—" };
    if (modes[field] === "masked") return { label: label(field), value: MASKED, testId };
    if (typeof raw !== "string" || !raw) return entityId === "sales.order" ? { label: label(field), value: t("sales.view.no_owner"), testId } : { label: label(field), value: "—" };
    return { label: label(field), value: named.owners.get(raw) ?? "—", testId };
  };

  const facts: SalesFact[] = [];
  const can: string[] = [];
  const allow = (step: string, when: boolean) => {
    const process = steps[step];
    if (when && process && runnable.has(process)) can.push(step);
  };
  const live = record.status !== "voided";
  const stage = typeof record.stage === "string" ? record.stage : null;
  let shownStage: string | null = stage;
  let stageField = "stage";
  let relatedLabel = "";
  let relatedEntity = "";
  switch (entityId) {
    case "crm.quote":
      facts.push(ref("party_id", "core.party"), ref("opportunity_id", "crm.opportunity"), plain("issue_date"), plain("valid_until"), plain("currency"), plain("sent_at"), plain("accepted_at"), plain("expired_at"), plain("notes"));
      allow("send", live && stage === "open" && goesOn(record));
      allow("accept", live && (stage === "open" || stage === "sent") && goesOn(record));
      allow("expire", live && (stage === "open" || stage === "sent"));
      allow("to_order", live && stage === "accepted" && named.related.length === 0);
      relatedLabel = t("sales.view.orders");
      relatedEntity = "sales.order";
      break;
    case "sales.order":
      facts.push(
        ref("party_id", "core.party"),
        ownerFact("owner_id", "order-owner"),
        namedRef("quote_id", "crm.quote", named.quote),
        namedRef("opportunity_id", "crm.opportunity", named.deal),
        namedRef("warehouse_id", "inventory.warehouse", named.warehouse),
        plain("issue_date"),
        plain("delivery_date"),
        plain("currency"),
        plain("confirmed_at"),
        plain("cancelled_at"),
        plain("notes"),
      );
      if (named.credit) {
        facts.push({ label: t("sales.view.credit_limit"), value: t("sales.view.credit_value", { limit: companyMoney(named.credit.limit), available: companyMoney(named.credit.available) }), testId: "order-credit" });
      }
      allow("confirm", live && stage === "open" && goesOn(record));
      allow("cancel", live && (stage === "open" || stage === "confirmed") && named.related.length === 0);
      allow("to_delivery", live && (stage === "confirmed" || stage === "partially_delivered"));
      // Cambiar vendedor: any stage (it moves who sees the pedido, not the document), only for who may run sales.order.reassign.
      allow("reassign", true);
      relatedLabel = t("sales.view.deliveries");
      relatedEntity = "sales.delivery";
      break;
    case "sales.delivery":
      facts.push(
        orderRef(),
        ownerFact("order_owner_id", "order-owner"),
        ref("party_id", "core.party"),
        ref("warehouse_id", "inventory.warehouse"),
        plain("date"),
        plain("shipped_at"),
        plain("stock_refusal"),
        plain("re_reserve_note", { testId: "delivery-re-reserve" }),
        plain("notes"),
      );
      allow("ship", live && stage === "open" && (record.status === "saved" || record.status === "approved"));
      allow("to_return", live && stage === "shipped");
      relatedLabel = t("sales.view.returns");
      relatedEntity = "sales.return";
      break;
    case "sales.return":
      facts.push(ref("delivery_id", "sales.delivery"), orderRef(), ref("party_id", "core.party"), ref("warehouse_id", "inventory.warehouse"), plain("date"), plain("reason"), plain("received_at"), plain("stock_refusal"), plain("notes"));
      allow("receive", live && stage === "open" && (record.status === "saved" || record.status === "approved"));
      break;
    case "crm.lead":
      facts.push(ref("converted_party_id", "core.party"), ref("converted_opportunity_id", "crm.opportunity", { mono: true }), plain("converted_at"));
      allow("convert", stage !== "converted" && record.is_active !== false && record.status !== "pending");
      break;
    case "crm.opportunity":
      shownStage = typeof record.outcome === "string" ? record.outcome : null;
      stageField = "outcome";
      facts.push(ref("party_id", "core.party"), ref("lead_id", "crm.lead"), ref("pipeline_id", "crm.pipeline"), plain("stage_id"), plain("amount"), plain("probability"), plain("expected_close"), plain("closed_at"), plain("lost_reason"), plain("description"));
      allow("stage_move", live && record.outcome === "open");
      break;
    case "crm.activity":
      facts.push(plain("kind"), plain("subject"), ref("opportunity_id", "crm.opportunity"), ref("lead_id", "crm.lead"), ref("party_id", "core.party"), plain("due_at"), plain("done_at"), plain("notes"));
      shownStage = null;
      break;
    default:
      break;
  }
  const stageDef = entity.fields.find((f) => f.name === stageField);
  const members = can.includes("reassign") ? await withClaims(deps.sql, caller.claims, (tx) => activeMembers(tx)) : [];
  // A money the role does not see (masked, or null in the masked view) reads as the masked marker, never «$ 0,00».
  const money = (field: string) => moneyText(modes[field], record[field], currency);
  return {
    // An empty fact (no reference, not sent yet) is left out.
    facts: facts.filter((f) => f.value !== "—"),
    totals: entityId === "crm.quote" || entityId === "sales.order" ? { subtotal: money("subtotal"), discount: money("discount_total"), tax: money("tax_total"), total: money("total") } : null,
    linesGrid,
    stage: shownStage,
    stageLabel: shownStage && stageDef?.valuesKey && t.has(`${stageDef.valuesKey}.${shownStage}`) ? t(`${stageDef.valuesKey}.${shownStage}`) : shownStage,
    steps: can,
    related: relatedEntity && named.related.length > 0 ? { label: relatedLabel, items: named.related.map((r) => ({ entity: relatedEntity, id: r.id, number: r.number ?? r.id })) } : null,
    stages: named.stages.map((s) => ({ code: s.id, name: s.name ?? s.id, kind: s.kind })),
    stageId: typeof record.stage_id === "string" ? record.stage_id : null,
    reassign: can.includes("reassign") ? { members: members.map((m) => ({ code: m.id, name: m.name })), ownerId: typeof record.owner_id === "string" ? record.owner_id : null } : null,
  };
}
