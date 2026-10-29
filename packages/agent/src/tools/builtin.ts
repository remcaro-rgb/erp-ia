import { z } from "zod";
import { gridDenial, gridEntity, hasRecordPage, knownRoutes, recordHref, type Caller, type Registry, type ResolvedEntityDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolDescriptor, type ToolRefusal } from "./descriptor";
import { inputJsonSchema } from "./from-registry";

// The assistant's built-in tools (design §7.1 "Navigation"): `ui.navigate` and `ui.open_record` hand the screen a
// route to open. They are the only tools that are not registered processes (rule 1), and they may be, because they
// execute nothing on the server: no read, no write, no audit-worthy effect. The screen they open runs its own checks.
// Everything that reads or changes data is a registered process with a generated tool: reading rows is
// `kernel.data.query`, the help is `kernel.help.search`, a ticket is `support.ticket.create` (Task 17 review round 1).

export const BUILTIN_TOOLS = [
  { name: "ui__navigate", description: "Lleva al usuario a una pantalla de la aplicación (una ruta de los menús, por ejemplo /parties)." },
  { name: "ui__open_record", description: "Abre un registro en su ficha (entidad e id)." },
] as const;

export type BuiltinName = (typeof BUILTIN_TOOLS)[number]["name"];
const BUILTIN_NAMES = new Set<string>(BUILTIN_TOOLS.map((t) => t.name));
export const isBuiltin = (name: string): name is BuiltinName => BUILTIN_NAMES.has(name);

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

/** The built-in tools for the caller: the record tool only when they may read some entity whose records have a page. */
export async function builtinToolDescriptors(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ToolDescriptor[]> {
  const entities = (await consultableEntities(deps, caller, registry)).filter(hasRecordPage).map((e) => e.id);
  const description = (name: BuiltinName) => BUILTIN_TOOLS.find((t) => t.name === name)!.description;
  const navigate = inputJsonSchema(NavigateInput) as { properties: Record<string, Record<string, unknown>> };
  navigate.properties.href = { ...navigate.properties.href, examples: knownRoutes(registry) };
  const tools: ToolDescriptor[] = [
    { name: "ui__navigate", description: description("ui__navigate"), inputSchema: navigate as ToolDescriptor["inputSchema"], source: { type: "builtin" } },
  ];
  if (entities.length > 0) {
    tools.push({ name: "ui__open_record", description: description("ui__open_record"), inputSchema: withEntityEnum(OpenRecordInput, entities), source: { type: "builtin" } });
  }
  return tools;
}

const invalid = (error: z.ZodError): ToolRefusal => refusal("invalid_input", { details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });

/** Runs a built-in tool. Refusals come back as the result, for the model to explain. */
export async function runBuiltin(deps: RunProcessDeps, name: BuiltinName, input: unknown): Promise<unknown> {
  switch (name) {
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
      // Only a record with a page opens, where every link to it leads (rule 21: a user under Administración › Usuarios).
      if (!hasRecordPage(entity)) return refusal("invalid_input", { message: `${entity.id} has no page of its own` });
      return { action: "open_record", href: recordHref(entity.id, parsed.data.id) };
    }
  }
}
