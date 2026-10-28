import { z } from "zod";
import { gridDenial, gridEntity, GridState, knownRoutes, QueryError, runGridQuery, type Caller, type Registry, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolDescriptor, type ToolRefusal } from "./descriptor";
import { inputJsonSchema } from "./from-registry";

// The assistant's built-in tools (design §7.1): `data.query` reads an entity's rows the way its grid does, and the two
// navigation tools hand the screen a route to open. None changes state (rule 1: every change is a registered process),
// and none reaches past what the caller may see: `data.query` answers only for an entity whose own consult process
// the caller may run in an entitled company (the grid's check), through the masked view, under the caller's claims, so
// company RLS, the party scope and field masking apply and a hidden or masked field can neither be read, filtered nor
// sorted (rule 14). `help.search` and `support.ticket.create` are registered processes: they come from the registry
// (`kernel__help__search`, `support__ticket__create`), behind the role matrix like any other.

/** Rows `data.query` returns at most per call (rule 17: consult results are capped). */
export const MAX_QUERY_ROWS = 50;
const DEFAULT_QUERY_ROWS = 20;

export const BUILTIN_TOOLS = [
  {
    name: "data__query",
    description:
      "Consulta registros de una entidad (filtros, orden, columnas y búsqueda) con los campos que el rol del usuario puede ver; " +
      `devuelve como máximo ${MAX_QUERY_ROWS} filas y el total. Un campo oculto o enmascarado no se puede filtrar ni ordenar.`,
  },
  { name: "ui__navigate", description: "Lleva al usuario a una pantalla de la aplicación (una ruta de los menús, por ejemplo /parties)." },
  { name: "ui__open_record", description: "Abre un registro en su ficha (entidad e id)." },
] as const;

export type BuiltinName = (typeof BUILTIN_TOOLS)[number]["name"];
const BUILTIN_NAMES = new Set<string>(BUILTIN_TOOLS.map((t) => t.name));
export const isBuiltin = (name: string): name is BuiltinName => BUILTIN_NAMES.has(name);

const DataQueryInput = z.object({
  entity: z.string().min(1).max(100).describe("Id de la entidad, por ejemplo core.party"),
  filters: GridState.shape.filters.optional(),
  sort: GridState.shape.sort.optional(),
  columns: GridState.shape.columns,
  search: GridState.shape.search,
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(MAX_QUERY_ROWS).default(DEFAULT_QUERY_ROWS),
});
const NavigateInput = z.object({ href: z.string().min(1).max(300).describe("Ruta de la aplicación, empieza por /") });
const OpenRecordInput = z.object({ entity: z.string().min(1).max(100), id: z.uuid() });

/** The registered entities whose grid the caller may read (`gridDenial` is null). */
export async function consultableEntities(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ResolvedEntityDef[]> {
  const entities = registry.entities();
  const denials = await Promise.all(entities.map((entity) => gridDenial(deps, caller.claims, entity)));
  return entities.filter((_, i) => denials[i] === null);
}

const withEntityEnum = (schema: z.ZodType, entities: string[]) => {
  const json = inputJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
  json.properties.entity = { ...json.properties.entity, enum: entities };
  return json as ToolDescriptor["inputSchema"];
};

/** The built-in tools for the caller: the data and record tools only when they may read some entity. */
export async function builtinToolDescriptors(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ToolDescriptor[]> {
  const entities = (await consultableEntities(deps, caller, registry)).map((e) => e.id);
  const description = (name: BuiltinName) => BUILTIN_TOOLS.find((t) => t.name === name)!.description;
  const tools: ToolDescriptor[] = [];
  if (entities.length > 0) {
    tools.push({ name: "data__query", description: description("data__query"), inputSchema: withEntityEnum(DataQueryInput, entities), source: { type: "builtin" } });
  }
  const navigate = inputJsonSchema(NavigateInput) as { properties: Record<string, Record<string, unknown>> };
  navigate.properties.href = { ...navigate.properties.href, examples: knownRoutes(registry) };
  tools.push({ name: "ui__navigate", description: description("ui__navigate"), inputSchema: navigate as ToolDescriptor["inputSchema"], source: { type: "builtin" } });
  if (entities.length > 0) {
    tools.push({ name: "ui__open_record", description: description("ui__open_record"), inputSchema: withEntityEnum(OpenRecordInput, entities), source: { type: "builtin" } });
  }
  return tools;
}

const invalid = (error: z.ZodError): ToolRefusal => refusal("invalid_input", { details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });

/** Runs a built-in tool as the caller. Refusals come back as the result, for the model to explain. */
export async function runBuiltin(deps: RunProcessDeps, caller: Caller, name: BuiltinName, input: unknown): Promise<unknown> {
  switch (name) {
    case "data__query": {
      const parsed = DataQueryInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const { entity: entityId, limit, page, filters, sort, columns, search } = parsed.data;
      const entity = gridEntity(deps.registry, entityId);
      if (!entity) return refusal("not_found", { message: `unknown entity ${entityId}` });
      const denial = await gridDenial(deps, caller.claims, entity);
      if (denial) return refusal(denial);
      try {
        const state = GridState.parse({ filters: filters ?? [], sort: sort ?? [], page, pageSize: limit, columns, search });
        const { rows, total } = await runGridQuery(deps.sql, caller.claims, entity, state);
        return { entity: entity.id, rows, total, page, truncated: total > (page - 1) * limit + rows.length };
      } catch (error) {
        if (error instanceof QueryError) return refusal(error.code, { field: error.field });
        throw error;
      }
    }
    case "ui__navigate": {
      const parsed = NavigateInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const { href } = parsed.data;
      const path = href.split("?")[0]!;
      if (!href.startsWith("/") || href.startsWith("//") || !knownRoutes(deps.registry).includes(path)) {
        return refusal("invalid_input", { message: `${href} is not a screen of the app` });
      }
      return { action: "navigate", href };
    }
    case "ui__open_record": {
      const parsed = OpenRecordInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      const entity = gridEntity(deps.registry, parsed.data.entity);
      if (!entity) return refusal("not_found", { message: `unknown entity ${parsed.data.entity}` });
      return { action: "open_record", href: `/r/${entity.id}/${parsed.data.id}` };
    }
  }
}
