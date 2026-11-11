import { defineProcess, ProcessError, rateFeed, type ProcessContext, type RunProcessDeps, type Tx } from "@erp/kernel";
import { z } from "zod";
import { companyPack, idOutput, refuseDuplicate, rejectErrors } from "./common";

// Tasas de cambio (plan 2B.2 Task 34.1; FX design §2, §12; owner items 121, 122, 123; R34-2, R34-3). One rate per company, currency and
// day in core.exchange_rates (0147), in company currency per unit. Four processes:
//   * core.exchange_rate.set: a manual rate (normal sensitivity); refused with official_rate_exists on a day that holds the TRM;
//   * core.exchange_rate.override_official: replaces a TRM row (step-up by default, item 121), audited before/after, source manual;
//   * core.exchange_rate.import_official: reads the country's official rate through the pack and the RateFeed port, one TRM row per day of
//     its validity, never over a manual row (skipped and listed); a source that fails raises core.trm_import_failed to the admin role, one
//     open per company and day (subject: the day's row of the import log core.exchange_rate_imports), closed by a later success;
//   * core.exchange_rate.for_date: the rate of a currency on a date, the latest within 3 days before, else null.
// Other modules read rates only through core.v_exchange_rates (R34-2, rule 3).

/** How many days before the asked date a rate still answers for it (a weekend, a holiday). */
export const RATE_LOOKBACK_DAYS = 3;
/** The longest validity range the import accepts from a source (a long weekend is 4 days). */
const MAX_VALIDITY_DAYS = 10;
/** The recommendation's reason code (catalogue core.recommendation.trm_import_failed.*). */
export const TRM_IMPORT_FAILED = "trm_import_failed";
const UNIQUE_KEY = "exchange_rates_company_id_currency_rate_date_key";

const currency = z.string().regex(/^[A-Z]{3}$/, "La moneda debe ser un código ISO 4217 de tres letras, p. ej. USD");
const day = z.iso.date();
/** Company currency per unit: positive, at most six decimals. */
const rate = z
  .number()
  .finite()
  .positive("La tasa debe ser mayor que cero")
  .refine((n) => n < 1e12, "Tasa fuera de rango")
  .refine((n) => Math.abs(Math.round(n * 1e6) - n * 1e6) < 1e-3, "La tasa admite como máximo seis decimales");
const note = z.string().trim().max(500, "La nota admite como máximo 500 caracteres");

/** A refusal whose message leads with its code (the module convention): the first detail follows the code. */
function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

interface Company {
  currency: string;
  today: string;
}

/** The caller's company: its currency and today's date in its time zone. */
async function companyOf(ctx: ProcessContext): Promise<Company> {
  const [row] = await ctx.tx<{ currency: string; today: string }[]>`
    select currency_code as currency, (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today
    from kernel.companies where id = ${ctx.companyId}`;
  return row!;
}

/** Refuses a currency that is not in core.currencies or is the company's own. */
async function foreignCurrency(ctx: ProcessContext, processId: string, code: string): Promise<void> {
  const company = await companyOf(ctx);
  const [known] = await ctx.tx`select 1 from core.currencies where code = ${code}`;
  if (!known) rejectErrors(processId, [`La moneda ${code} no existe`]);
  if (code === company.currency) rejectErrors(processId, [`${code} es la moneda de la empresa: su tasa es siempre 1`]);
}

/** The rate as the user reads it: es-CO digits, up to six decimals (FX §10). */
const rateText = (n: number) => n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

type RateRow = { id: string; source: "trm" | "manual"; rate: string; official_rate: string | null };

async function lockedRow(tx: Tx, companyId: string, code: string, date: string): Promise<RateRow | undefined> {
  const [row] = await tx<RateRow[]>`
    select id, source, rate::text, official_rate::text from core.exchange_rates
    where company_id = ${companyId} and currency = ${code} and rate_date = ${date}::date for update`;
  return row;
}

export const exchangeRateSet = defineProcess({
  id: "core.exchange_rate.set",
  module: "core",
  kind: "create",
  feature: "core.settings",
  recordAccess: "none",
  description:
    "Registra la tasa de cambio manual de una moneda para un día (pesos por unidad, p. ej. USD 4.123,45); si ese día ya tiene la TRM, se rechaza: para reemplazarla se usa «Reemplazar TRM»",
  input: z.object({ currency, rateDate: day, rate, note: note.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await foreignCurrency(ctx, "core.exchange_rate.set", input.currency);
    const current = await lockedRow(ctx.tx, ctx.companyId, input.currency, input.rateDate);
    if (current?.source === "trm") {
      refuse("official_rate_exists", [
        `Ya hay una TRM para ${input.currency} el ${input.rateDate} (${rateText(Number(current.rate))}); para cambiarla usa «Reemplazar TRM», que pide el segundo factor`,
      ]);
    }
    if (current) {
      await ctx.tx`update core.exchange_rates set rate = ${input.rate}, note = ${input.note ?? null} where id = ${current.id}`;
      return { id: current.id };
    }
    const values = { company_id: ctx.companyId, currency: input.currency, rate_date: input.rateDate, rate: input.rate, source: "manual", note: input.note ?? null };
    const [inserted] = await refuseDuplicate("core.exchange_rate.set", UNIQUE_KEY, `Ya hay una tasa para ${input.currency} el ${input.rateDate}`, () =>
      ctx.tx<{ id: string }[]>`insert into core.exchange_rates ${ctx.tx(values)} returning id`,
    );
    return { id: inserted!.id };
  },
});

export const exchangeRateOverrideOfficial = defineProcess({
  id: "core.exchange_rate.override_official",
  module: "core",
  kind: "update",
  feature: "core.settings",
  recordAccess: "none",
  sensitivity: "step-up",
  description:
    "Reemplaza la TRM de un día por otra tasa (pide el segundo factor y una nota); la tasa queda manual, la TRM publicada se conserva y la auditoría guarda el valor anterior y el nuevo",
  input: z.object({ currency, rateDate: day, rate, note: note.min(1, "Indica por qué reemplazas la TRM") }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await foreignCurrency(ctx, "core.exchange_rate.override_official", input.currency);
    const current = await lockedRow(ctx.tx, ctx.companyId, input.currency, input.rateDate);
    if (!current || current.source !== "trm") {
      refuse("official_rate_missing", [`No hay una TRM para ${input.currency} el ${input.rateDate}; registra la tasa manual con «Registrar tasa»`]);
    }
    await ctx.tx`
      update core.exchange_rates set rate = ${input.rate}, source = 'manual', official_rate = ${current!.rate}::numeric, note = ${input.note}
      where id = ${current!.id}`;
    return { id: current!.id };
  },
});

const skippedRow = z.object({ rateDate: z.string(), manualRate: z.number(), officialRate: z.number() });

/** The days from `from` to `to`, inclusive (YYYY-MM-DD). */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Writes the import log row of a currency and day (one per company, currency and day): the attempt count goes up on every run. */
async function logImport(ctx: ProcessContext, code: string, date: string, status: "imported" | "failed", written: number, error: string | null) {
  const [row] = await ctx.tx<{ id: string; was: string | null }[]>`
    with before as (select status from core.exchange_rate_imports where company_id = ${ctx.companyId} and currency = ${code} and rate_date = ${date}::date)
    insert into core.exchange_rate_imports as i (company_id, currency, rate_date, status, written, error)
    values (${ctx.companyId}, ${code}, ${date}::date, ${status}, ${written}, ${error})
    on conflict (company_id, currency, rate_date) do update
      set status = excluded.status, written = i.written + excluded.written, error = excluded.error, attempts = i.attempts + 1
    returning i.id, (select status from before) as was`;
  return { id: row!.id, wasFailed: row!.was === "failed" };
}

export const exchangeRateImportOfficial = defineProcess({
  id: "core.exchange_rate.import_official",
  module: "core",
  kind: "create",
  feature: "core.settings",
  recordAccess: "none",
  origins: ["scheduler", "ui"],
  description:
    "Trae la tasa oficial del día (en Colombia, la TRM del dólar) y la registra para cada día de su vigencia; nunca cambia una tasa manual. Si la fuente no responde, avisa al administrador",
  input: z.object({ date: day.optional() }).strict(),
  output: z.object({ written: z.number().int(), skipped: z.array(skippedRow), failed: z.array(z.string()) }),
  handler: async (ctx, input) => {
    const pack = await companyPack(ctx);
    const official = pack.exchangeRates;
    if (!official) refuse("official_rate_unavailable", ["El país de la empresa no publica una tasa de cambio oficial: registra las tasas a mano"]);
    const company = await companyOf(ctx);
    const date = input.date ?? company.today;
    const feed = rateFeed();
    let written = 0;
    const skipped: z.infer<typeof skippedRow>[] = [];
    const failed: string[] = [];
    for (const code of official!.officialCurrencies) {
      if (code === company.currency) continue;
      let answer: Awaited<ReturnType<typeof official.officialRate>> = null;
      let error: string | null = null;
      try {
        answer = await official!.officialRate(code, date, feed);
        if (!answer) error = `La fuente no publica tasa de ${code} para el ${date}`;
        else if (answer.validFrom > date || answer.validTo < date || daysBetween(answer.validFrom, answer.validTo).length > MAX_VALIDITY_DAYS) {
          error = `La fuente respondió una vigencia que no sirve para el ${date} (${answer.validFrom} a ${answer.validTo})`;
        }
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      }
      if (error || !answer) {
        failed.push(code);
        const log = await logImport(ctx, code, date, "failed", 0, error);
        await raiseImportFailed(ctx, log.id, code, date);
        continue;
      }
      for (const d of daysBetween(answer.validFrom, answer.validTo)) {
        const current = await lockedRow(ctx.tx, ctx.companyId, code, d);
        let wrote = 0;
        if (!current) {
          const [row] = await ctx.tx<{ id: string }[]>`
            insert into core.exchange_rates (company_id, currency, rate_date, rate, source)
            values (${ctx.companyId}, ${code}, ${d}::date, ${answer.rate}, 'trm')
            on conflict (company_id, currency, rate_date) do nothing returning id`;
          wrote = row ? 1 : 0;
        } else if (current.source === "trm" && Number(current.rate) !== answer.rate) {
          await ctx.tx`update core.exchange_rates set rate = ${answer.rate} where id = ${current.id}`;
          wrote = 1;
        } else if (current.source === "manual") {
          skipped.push({ rateDate: d, manualRate: Number(current.rate), officialRate: answer.rate });
          if (current.official_rate === null || Number(current.official_rate) !== answer.rate) {
            await ctx.tx`update core.exchange_rates set official_rate = ${answer.rate} where id = ${current.id}`;
          }
        }
        written += wrote;
        const log = await logImport(ctx, code, d, "imported", wrote, null);
        if (log.wasFailed) await ctx.recommendations?.close({ subject: { entity: "core.exchange_rate_import", id: log.id }, reason: TRM_IMPORT_FAILED });
      }
    }
    return { written, skipped, failed };
  },
});

/**
 * Raises (or merges into) the day's feed-failure recommendation (item 121; one open per company and day). The audience is the company's
 * admin role and, because a process row needs an audience process (0123), the holders of the import, who can run «Traer TRM» again (the
 * admin holds every process; the demo's contador holds the import).
 */
async function raiseImportFailed(ctx: ProcessContext, logId: string, code: string, date: string): Promise<void> {
  const [admin] = await ctx.tx<{ id: string }[]>`select id from kernel.roles where company_id = ${ctx.companyId} and is_system and name = 'admin'`;
  await ctx.recommendations?.raise({
    audienceProcess: "core.exchange_rate.import_official",
    ...(admin ? { audienceRoleId: admin.id } : {}),
    subject: { entity: "core.exchange_rate_import", id: logId },
    reason: TRM_IMPORT_FAILED,
    titleKey: "core.recommendation.trm_import_failed.title",
    bodyKey: "core.recommendation.trm_import_failed.body",
    params: { currency: { value: code }, date: { value: date } },
  });
}

const forDateOutput = z.object({ rate: z.number(), source: z.enum(["trm", "manual"]), rateDate: z.string() }).nullable();

/** The rate of `code` on `date` read through core.v_exchange_rates: the day's row, else the latest within RATE_LOOKBACK_DAYS before. */
export async function rateForDate(tx: Tx, companyId: string, code: string, date: string): Promise<z.infer<typeof forDateOutput>> {
  const [row] = await tx<{ rate: string; source: "trm" | "manual"; rate_date: string }[]>`
    select rate::text, source, rate_date::text from core.v_exchange_rates
    where company_id = ${companyId} and currency = ${code}
      and rate_date between ${date}::date - ${RATE_LOOKBACK_DAYS}::int and ${date}::date
    order by rate_date desc limit 1`;
  return row ? { rate: Number(row.rate), source: row.source, rateDate: row.rate_date } : null;
}

export const exchangeRateForDate = defineProcess({
  id: "core.exchange_rate.for_date",
  module: "core",
  kind: "consult",
  feature: "core.settings",
  description:
    "Consulta la tasa de cambio de una moneda en una fecha (p. ej. la TRM de hoy): la del día o la más reciente de los 3 días anteriores, con su origen (TRM o manual); nada si no hay",
  input: z.object({ currency, date: day }).strict(),
  output: forDateOutput,
  handler: (ctx, input) => rateForDate(ctx.tx, ctx.companyId, input.currency, input.date),
});

export const EXCHANGE_RATE_PROCESSES = [exchangeRateSet, exchangeRateOverrideOfficial, exchangeRateImportOfficial, exchangeRateForDate];

/**
 * The companies the daily official-rate import runs for (R34-3), over the service connection: those with a row in core.exchange_rates or
 * a price list in a currency other than their own, whose country pack publishes official rates (`hasOfficialRates`). Each with its time
 * zone, for the 07:00 tenant-time rule of the scheduled check.
 */
export async function officialRateCompanies(sql: RunProcessDeps["sql"], hasOfficialRates: (countryCode: string) => boolean): Promise<{ companyId: string; timeZone: string }[]> {
  const rows = await sql<{ id: string; country_code: string; timezone: string | null }[]>`
    select c.id, c.country_code, c.timezone from kernel.companies c
    where exists (select 1 from core.exchange_rates r where r.company_id = c.id)
       or exists (select 1 from core.price_lists p where p.company_id = c.id and p.currency_code <> c.currency_code and p.deleted_at is null)
    order by c.id`;
  return rows.filter((r) => hasOfficialRates(r.country_code)).map((r) => ({ companyId: r.id, timeZone: r.timezone ?? "America/Bogota" }));
}
