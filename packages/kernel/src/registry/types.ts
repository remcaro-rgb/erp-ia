import type { ReportDef } from "../reports/types";
import type { z } from "zod";
import type { Sql } from "postgres";
import type { Tx } from "../db/client";
import type { ProcessContext } from "../process/context";
import type { Origin } from "../audit/audit";
import type { EntityDef } from "./entities";
import type { DefaultPostingRule, PostingProvider } from "../posting/provider";
import type { TypedHooks } from "../typed/runner";
import type { DefaultPresentation } from "../templates/defaults";
import type { Template, TemplateScope } from "../templates/schema";

export type ProcessKind = "create" | "update" | "delete" | "consult";

/**
 * A registered process: the only way state changes (design §5.4). Handlers and keys are declared as
 * methods so a process with a concrete input schema is assignable to the registry's `ProcessDef`.
 */
export interface ProcessDef<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  /** `<module>.<entity>.<verb>`, e.g. `sales.order.confirm`. */
  id: string;
  module: string;
  kind: ProcessKind;
  input: I;
  output: O;
  /** Spanish (es-419); used as the assistant's tool description. */
  description: string;
  feature?: string;
  /**
   * `step-up` requires a fresh step-up unless the company exempted it; a company admin can require it for any other process
   * through `kernel.sensitive_processes` (owner 2026-11-11: the admin decides every process; a row `exempt` switches off a definition's step-up).
   */
  sensitivity?: "normal" | "step-up";
  /**
   * `none` opts a self-service process (a user's own preferences) out of the per-role permission matrix:
   * any member of the active company may run it. It is still resolved, entitled, validated, step-up
   * checked and audited like any other process. Default `role`.
   */
  permission?: "role" | "none";
  /**
   * When set, `runProcess` refuses any other `caller.origin` with `forbidden` at the gate, before the role check; the
   * admin's sensitive-processes page leaves the process out and the assistant gets no tool for it (the posting
   * engine's writes run only from an event consumer).
   */
  origins?: Origin[];
  /**
   * When set, the process runs only nested (ctx.runProcess) in one of these parent processes: `runProcess` refuses it on its own
   * and from any other parent with `forbidden` (plan 2B Task 18: the annulment note runs only inside invoicing.invoice.void, whose
   * step-up covers it). Its parent's role gate covers it too (no role is granted it). Like `origins`, it is left out of the admin's sensitive-processes page and the assistant gets no tool for it.
   */
  nestedOnlyFrom?: string[];
  /**
   * The record-level guard (kernel.record_access, spec 2026-11-02 §9.1). runProcess derives it from the name for an update or delete
   * process `<entity>.<verb>` of a maestro or documento with an `id` input (void → void; delete → delete on a maestro, modify on
   * a documento; any other, deactivate and activate included → modify). Every other create / update / delete process of a module that owns a maestro or documento, and
   * every kernel process that writes to a record named by `entity` + `recordId`, declares it (review I4; registry test
   * `uncoveredRecordWrites`):
   *   - `{ entity, idField, right }`: runProcess checks `right` on `input[idField]` of `entity` before the handler;
   *   - `"handler"`: the target is found by the handler (a contact's party, an attachment's record), which enforces the right itself
   *     (assertRecordRight, or reading the record under RLS for read);
   *   - `"none"`: the process changes no record of a maestro or documento (settings, parametros, admin configuration, a new record).
   */
  recordAccess?: { entity: string; idField: string; right: "read" | "use" | "modify" | "delete" | "void" } | "handler" | "none";
  /**
   * Events the process writes to the outbox, its nested runs' included; the confirmation card asks each posting provider and each module's
   * `effects` what they will do (design §5.1).
   */
  emits?: string[];
  /** What the audit entry of a run records as its input, when less than the whole input (default: the whole input). */
  auditInput?(input: z.infer<I>): unknown;
  /** Runs with the same key in the same company return the first run's stored result; undefined runs the process without a replay. */
  idempotencyKey?(input: z.infer<I>): string | undefined;
  /**
   * A replay (same idempotency key) returns the first run's stored result, written in the run's transaction, before its post-commit
   * steps ran. When set, the stored result is refreshed through this hook, as the caller under RLS (Notificar reads its log row's
   * outcome, so a replay answers sent / failed, not the «queued» stored before the send).
   */
  replay?(tx: Tx, stored: z.infer<O>): Promise<z.infer<O>>;
  /** Runs in the process transaction, as the caller, under RLS. */
  handler(ctx: ProcessContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/** A menu entry a module contributes (design §5.2, §19a). */
export interface NavItem {
  id: string;
  /** i18n key. */
  label: string;
  href: string;
  icon: string;
  /** Feature id (`core.parties`) that must be entitled for the item to show. */
  feature?: string;
  /** Process id one of the caller's roles must be able to run for the item to show (`kernel.import.run`). */
  process?: string;
  /** Like `process`, but any one of these ids runnable by one of the caller's roles shows the item (the nested-run queue: retry or dismiss). */
  anyProcess?: string[];
  /** Shows in the active module's horizontal items bar. Default true. */
  menu?: boolean;
  /**
   * Makes the item a group: a dropdown in the items bar (`Maestros ▾`) listing these items. One level only (a child never
   * has children); the group's `href` is `"#"`. The shell keeps only the children the caller may open and drops an empty
   * group; ⌘K lists the children, never the group.
   */
  children?: NavItem[];
  /** A count the shell shows beside the label (the pending postings of the accounting bar); set by the shell at load time, never declared by a manifest. */
  badge?: number;
  /**
   * Menu sections (entity types spec 2026-11-02 §2.4, §9.2). On a group: the group is that level-1 section of its module and must be
   * named `<module>.<section>` (`menuSections` builds the four). On a top-level leaf: the loader moves the item into that section.
   */
  section?: MenuSection;
  /**
   * The entity whose list page this item is (`core.party` for Terceros). A maestro, documento or parametro places the item in its
   * section (Maestros, Documentos, Parámetros); while the item is hidden for a caller (kernel.menu_access) the entity's processes, its
   * lines' and its record pages (`/r/<entity>/…`) are refused to them as well.
   */
  entity?: string;
  /**
   * Further processes the screen runs, as ids or id prefixes ending in "." (`accounting.report.`): refused, like the entity's, while the
   * item is hidden for the caller. Only processes of the item's own module.
   */
  runs?: string[];
}

/** The four level-1 items every module menu has (entity types spec §2.4), in their order. */
export type MenuSection = "maestros" | "documentos" | "reportes" | "parametros";

/** A named group of processes and entities a tenant can be entitled to (design §5.12). */
export interface FeatureDef {
  /** `<module>.<name>`, e.g. `core.parties`. */
  id: string;
  /** i18n key. */
  label: string;
  /** Ids of processes of the same module. */
  processes: string[];
  /** Ids of entities of the same module. */
  entities: string[];
  nav?: NavItem[];
}

/** What an event consumer receives; `buildConsumerContext` (events/consumers.ts) builds it for the dispatch workflow. */
export interface ConsumerContext {
  sql: Sql;
  companyId: string;
  chainId: string;
  /** The outbox row being delivered. */
  event: { id: string; name: string; createdAt: Date };
  /** Runs a process with origin `event`, as the system user. */
  runProcess: (processId: string, input: unknown) => Promise<unknown>;
}

export type EventConsumer = (ctx: ConsumerContext, payload: unknown) => Promise<void>;

/**
 * One number on the home screen (design §19a). Language-neutral: `label` and `detail.key` are i18n keys the screen
 * translates, `params` the numbers the detail line shows; money-like formatting is the screen's.
 */
export interface Kpi {
  /** `<module>.<name>`; unique among the KPIs of a response. */
  id: string;
  /** i18n key of the card's title. */
  label: string;
  value: number;
  /** `percent` shows `38 %`, `tokens` a compact count (`1,9 M`), `count` a whole number, `money` an amount in the company's currency (`$ 1.234.567,00`, rule 23), `ratio` a quotient with two decimals (`1,85`). */
  unit: "count" | "percent" | "tokens" | "money" | "ratio";
  /** 0–1: fills the small bar under the number. */
  progress?: number;
  /** `warn` tints the number (something wants attention). */
  tone?: "default" | "warn";
  /**
   * Where the number's work is (owner 2026-10-31, UX-OD-7): the grid or report holding it, with the KPI's filter (`kpiGridHref`).
   * The card is a link to it for a caller who may open it; absent: the card is not a link.
   */
  href?: string;
  /** The line under the number: an i18n key and the values it shows. */
  detail?: { key: string; params: Record<string, string | number> };
  /**
   * OD-9: the trend line under the number. Exactly 14 daily values (oldest first, today last, on the company's calendar) of
   * the same measure, computed by the provider in SQL as the caller (`dailySeries`); the card draws it when present.
   */
  series?: number[];
}

/**
 * What a module registers to put KPIs on the home screen (design §19a, Task 20). `kernel.home.kpis` runs the providers
 * whose `feature` the company is entitled to, as the caller (the process transaction, RLS and masked views apply), and
 * only for a caller whose roles may run `consult` when the provider names one (rule 13). Its catalogue texts (the name and the one-line
 * description the "Personalizar página de inicio" dialog shows) are the i18n keys `home.catalog.<id with dots as _>.label` and `.description`.
 */
export interface HomeKpiProvider {
  /** `<module>.<name>`, in the namespace of the module that ships it. */
  id: string;
  /** Feature id (`core.parties`) the company must be entitled to; in the provider's module namespace. */
  feature: string;
  /** Process id a role of the caller must be allowed to run for the KPIs to show (a consult over the same data). */
  consult?: string;
  compute(ctx: ProcessContext): Promise<Kpi[]>;
}

/**
 * One chart of a module's Inicio (design §19a). Language-neutral like a KPI: `label` and the series' `label`s are i18n keys,
 * the point labels are either i18n keys (`i18n: true`, a status or a kind) or the text itself (a month `2026-10`, an account name).
 * `bar` draws the points as bars (grouped when there are several series), `line` as a trend; the screen picks the formats.
 */
export interface Chart {
  /** `<module>.<name>`; unique among the charts of a response. */
  id: string;
  /** i18n key of the chart's title. */
  label: string;
  kind: "bar" | "line";
  /** How the values read: the same units as a KPI. */
  unit: "count" | "percent" | "tokens" | "money";
  series: { label: string; points: { label: string; value: number }[] }[];
  /** The point labels are i18n keys. */
  i18n?: boolean;
  /** Where the chart's work is, like `Kpi.href`. */
  href?: string;
}

/**
 * What a module registers to put charts on its Inicio page (design §19a). Same gates as a KPI provider: the `feature` the company
 * holds and the `consult` process a role of the caller may run; the numbers are read as the caller. Its catalogue texts (the title and the
 * one-line description the "Personalizar página de inicio" dialog shows) are the i18n keys `home.catalog.<id with dots as _>.label` and `.description`.
 */
export interface HomeChartProvider {
  /** `<module>.<name>`, in the namespace of the module that ships it. */
  id: string;
  feature: string;
  consult?: string;
  compute(ctx: ProcessContext): Promise<Chart[]>;
}

/**
 * A tab a module adds to the record page of other modules' entities (design §5.16, accounting design §8), so the kernel
 * shows a module's data without knowing it (rule 4). The page resolves a contribution per record: the company must hold
 * its `feature`, and a `grid` shows only when its source has rows for the record.
 */
export interface RecordTabContribution {
  /** `<module>.<name>`, in the namespace of the module that ships it. */
  id: string;
  /** i18n key of the tab's name. */
  label: string;
  /** `"*"` adds the tab to every record page; a list names the entities (`core.product_category`). */
  forEntities: "*" | string[];
  kind: "grid" | "mapping";
  /** Feature id of the module the company must be entitled to. */
  feature: string;
  /** grid: a registered query entity whose view has `source_entity` and `source_record_id` columns; shown only when it has rows for the record. */
  source?: string;
  /**
   * grid: the source column that holds the record's id (`order_id`: the pedido's alistamientos, plan 2B.2 Task 29.4, RG-9); the source is
   * then filtered by it alone instead of by `source_entity` and `source_record_id`.
   */
  recordField?: string;
  /**
   * grid: a button the tab offers on the record, running one of the module's own processes with `{ [inputField]: <record id> }` as the
   * caller (rule 1: the process decides; a refusal shows its reasons). A caller who may run it sees the tab even while the source has no
   * rows for the record (RG-9: «Crear alistamiento» on a pedido with none yet).
   */
  action?: { label: string; process: string; inputField: string };
  /** mapping: the dimension template (`category:{id}`, `{id}` is the record id). */
  dimension?: string;
  /** mapping: the roles to map, one lookup each. */
  roles?: string[];
  /** mapping: the entity each role's lookup chooses from. */
  lookupEntity?: string;
  /** mapping: the process that saves the mapping (step-up applies as the process declares). */
  saveProcess?: string;
  /** mapping: the consult process that returns the stored mappings. */
  consultProcess?: string;
}

/** The manifest every module ships (design §5.2). */
export interface ModuleDef {
  /** Lowercase identifier; also the Postgres schema and the first segment of its process and feature ids. */
  id: string;
  version: string;
  /** Modules that must be loaded, and enabled for a company, before this one. */
  dependsOn: string[];
  /**
   * Modules this one uses without a load-order edge (plan 2B Task 41, Ruling R41-1): each must be loaded, but `needs` takes no part in
   * the load order, so two modules may need each other's schema (inventory needs costing, which dependsOn inventory). Only disabling a
   * needed module is refused while the needer is enabled; enabling the needer does not force the needed module on.
   */
  needs?: string[];
  entities: EntityDef[];
  processes: ProcessDef[];
  features: FeatureDef[];
  /** `consumes` is keyed by event name; `"*"` consumes every event, after the module-specific consumers of that event. */
  events: { emits: string[]; consumes: Record<string, EventConsumer> };
  navigation: NavItem[];
  /** The module's mark in the shell's side menu: a `NavItem.icon` name (the shell falls back to the name's first letter). */
  icon?: string;
  /**
   * Menu items of a module this one depends on that the shell shows in this module's menu instead of their own, in the same section
   * (Terceros of `core` under Contabilidad's Maestros: owner 2026-11-03). Only the placement moves: the item keeps its feature, its
   * guard and its menu-access key, and it stays in its own module's menu when this module is not entitled.
   */
  adopts?: string[];
  /**
   * Menu items this module places in the section group of a module it depends on (plan 2B Task 42, Ruling R42-1): `under` is the target
   * group id (`<module>.<section>`, e.g. `sales.documentos`), whose module must be in `dependsOn`, so the target module never names the
   * contributor. The shell adds the item last in the group, only when this module is entitled and the item's feature and process pass;
   * the module's own item stays in its menu. The shortcut's id is its own (it is not in `navigation`).
   */
  shortcuts?: { item: NavItem; under: string }[];
  /** KPIs the module contributes to the home screen. */
  homeKpis?: HomeKpiProvider[];
  /** Charts the module contributes to its Inicio page. */
  homeCharts?: HomeChartProvider[];
  /** Tabs the module adds to the record pages of entities (its own or other modules'). */
  recordTabs?: RecordTabContribution[];
  /** Reports the module ships (design §9): a parameter bar over a consult process. */
  reports?: ReportDef[];
  /**
   * Processes no single menu item guards (entity types spec §9.2), as ids or id prefixes ending in ".": lookups, numbering and settings
   * many screens read, or processes whose screen does not exist yet. Every other process of a module with a menu sits under a menu item
   * (its entity, its `recordAccess.entity` or its `runs`), so hiding the item refuses it; `uncoveredMenuProcesses` (module/menu.ts) lists
   * the ones that do neither and each module's test asserts there are none.
   */
  menuShared?: string[];
  /** Receives the posting engine's composed entries (design §5.1); at most one module provides it. */
  postingProvider?: PostingProvider;
  /**
   * What the module does that a confirmation card must tell (design §5.1 `effectsFor`, plan 2B Task 25), as i18n keys of the module's own
   * namespace (`<module>.effects.<name>`) whose text reads "Label: what happens" ("Inventario: reserva el stock del pedido"). Keyed by an
   * event name (what the module does when the event happens: a consumer's work, or what follows from it in the module, rule 3: by name
   * only) or by the id of one of the module's own processes (what a run of it does beyond the events it emits). The assistant's card lists,
   * for a write, the lines of every module the company has for the process and each event it emits, then the posting provider's lines.
   */
  effects?: Record<string, readonly string[]>;
  /** Posting rules the module ships for its events (design §5.4). */
  postingRules?: DefaultPostingRule[];
  /** Account roles the module adds to the kernel catalogue; the country pack must map them. */
  accountRoles?: string[];
  /**
   * The module's hooks into the lifecycle of its own maestros and documentos (entity types spec §5, D9), keyed by entity id:
   * validation at Grabar / Aprobar / Contabilizar, the document number, the posting. The kernel's generic processes call them;
   * the kernel never names the module (rule 4).
   */
  typedHooks?: Record<string, TypedHooks>;
  /**
   * The template a maestro or documento of the module prints with when the company chose none (entity types spec §6: "each entity ships a
   * seeded default template, it works with no admin action"), keyed by entity id and scope. The builder gets the print's presentation (the
   * caller's labels, the title, the tax id's name) and returns a built-in template (`id: null`, version 0); without one the kernel generates
   * the template from the entity's fields (templates/defaults.ts). A company template set as default always wins.
   */
  printTemplates?: Record<string, Partial<Record<TemplateScope, (presentation: DefaultPresentation) => Template>>>;
  /**
   * Variables the module adds to the print of one record of its maestro or documento, keyed by entity id (plan 2B Task 19: the electronic
   * invoice's QR code, its CUFE and the numbering legend). Any template of the entity (the shipped one, a company's) may name them; the
   * kernel resolves them after the record's own fields, in the print's transaction as the caller.
   */
  printVariables?: Record<string, PrintVariables>;
  migrationsDir?: string;
}

/** What a module adds to a record print of one of its entities (ModuleDef.printVariables). */
export interface PrintVariables {
  /** The text variables (a `variable` block names them). */
  names: readonly string[];
  /** The image variables (an `image` block names them; the value is a `data:image/png|jpeg;base64,` URI, or "" for none). */
  images?: readonly string[];
  /**
   * The values of `names` and `images` for the record `recordId`, read as the caller in the print's transaction (what the caller may not
   * read is not printed); `locale` is the print's language, `printedAt` its instant. A missing value prints empty.
   */
  resolve(ctx: ProcessContext, recordId: string, options: { locale: string; printedAt: Date }): Promise<Record<string, string>>;
}
