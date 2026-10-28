import type { z } from "zod";
import type { Sql } from "postgres";
import type { ProcessContext } from "../process/context";
import type { EntityDef } from "./entities";

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
   * `step-up` always requires a fresh step-up; a company admin can require it for any other process
   * through `kernel.sensitive_processes` (admins raise sensitivity, never lower it).
   */
  sensitivity?: "normal" | "step-up";
  /** Runs with the same key in the same company return the first run's stored result. */
  idempotencyKey?(input: z.infer<I>): string;
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
  /** Shows in the active module's horizontal items bar. Default true. */
  menu?: boolean;
}

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
  /** Runs a process with origin `event`, as the system user. */
  runProcess: (processId: string, input: unknown) => Promise<unknown>;
}

export type EventConsumer = (ctx: ConsumerContext, payload: unknown) => Promise<void>;

/** The manifest every module ships (design §5.2). */
export interface ModuleDef {
  /** Lowercase identifier; also the Postgres schema and the first segment of its process and feature ids. */
  id: string;
  version: string;
  /** Modules that must be loaded, and enabled for a company, before this one. */
  dependsOn: string[];
  entities: EntityDef[];
  processes: ProcessDef[];
  features: FeatureDef[];
  events: { emits: string[]; consumes: Record<string, EventConsumer> };
  navigation: NavItem[];
  migrationsDir?: string;
}
