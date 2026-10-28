import type { z } from "zod";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import type { ProcessDef } from "../registry/types";

// What an import of an entity writes (design §5.11): one column per key of the entity's create process input, in
// the schema's order, typed from the schema. The admin-defined extra data (`extra`, `extraFree`) is not a column.

export type ImportColumnType = "text" | "number" | "boolean" | "list" | "multi" | "ref";

export interface ImportColumn {
  /** Key of the create process input (`documentNumber`). */
  key: string;
  /** Column / registry field name (`document_number`). */
  field: string;
  /** i18n key of the column's label (the registry field's label, or `field.<entity>.<field>`). */
  label: string;
  type: ImportColumnType;
  /** Without a value the row is refused (no default, not optional). */
  required: boolean;
  /** Allowed values of a `list` or `multi` column. */
  options?: string[];
  /** A `ref` column takes the target's id or its display value (`Categoría` by name). */
  ref?: { entity: string; display: string };
}

/** Input keys never imported as columns: the record's extra data has its own forms. */
const SKIPPED = new Set(["extra", "extraFree"]);

const refuse = (message: string, detail: string) => new ProcessError("invalid_input", message, { details: [detail] });

/** The entity to import into and its create process (`processIds.create` or `<entity id>.create`); `invalid_input` otherwise. */
export function importTarget(registry: Registry, entityId: string): { entity: ResolvedEntityDef; createProcess: ProcessDef } {
  const entity = registry.entities().find((e) => e.id === entityId);
  if (!entity) throw refuse(`unknown entity ${entityId}`, `La entidad ${entityId} no existe`);
  const processId = entity.processIds?.create ?? `${entity.id}.create`;
  const createProcess = registry.processes().find((p) => p.id === processId);
  if (!createProcess || createProcess.kind !== "create") {
    throw refuse(`${entityId} has no create process`, `La entidad ${entityId} no admite importación`);
  }
  return { entity, createProcess };
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  entries?: Record<string, string>;
  values?: unknown[];
  shape?: Record<string, z.ZodType>;
}
const defOf = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;

/** Strips optional / default / nullable / pipe wrappers: the value type, and whether a value may be left out. */
function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  for (;;) {
    const def = defOf(inner);
    if (def.type === "optional" || def.type === "default" || def.type === "prefault" || def.type === "nullable" || def.type === "catch") {
      if (def.type !== "nullable") optional = true;
      inner = def.innerType!;
    } else if (def.type === "pipe") {
      inner = def.in!;
    } else if (def.type === "union") {
      // `clearable(x)`: x or "" — the value type is the first member.
      inner = def.options![0]!;
    } else {
      return { inner, optional };
    }
  }
}

/** Allowed values of an enum or literal schema, else undefined. */
function enumValues(schema: z.ZodType): string[] | undefined {
  const def = defOf(unwrap(schema).inner);
  if (def.type === "enum") return Object.values(def.entries!);
  if (def.type === "literal") return def.values!.map(String);
  return undefined;
}

function columnOf(entity: ResolvedEntityDef, key: string, schema: z.ZodType): ImportColumn {
  const { inner, optional } = unwrap(schema);
  const def = defOf(inner);
  const field = snake(key);
  const registryField = entity.fields.find((f) => f.name === field);
  const base = { key, field, label: registryField?.label ?? `field.${entity.id}.${field}`, required: !optional };
  if (registryField?.type === "ref" && registryField.ref) return { ...base, type: "ref", ref: { ...registryField.ref } };
  switch (def.type) {
    case "number":
    case "int":
    case "bigint":
      return { ...base, type: "number" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
    case "literal":
      return { ...base, type: "list", options: enumValues(inner) };
    case "array": {
      const options = enumValues(def.element!);
      return { ...base, type: "multi", ...(options ? { options } : {}) };
    }
    default:
      return { ...base, type: "text" };
  }
}

/** The import columns of `entityId`, from its create process input (an object schema). */
export function importColumns(registry: Registry, entityId: string): ImportColumn[] {
  const { entity, createProcess } = importTarget(registry, entityId);
  const shape = defOf(createProcess.input).shape;
  if (!shape) throw refuse(`${createProcess.id} input is not an object`, `La entidad ${entityId} no admite importación`);
  return Object.entries(shape)
    .filter(([key]) => !SKIPPED.has(key))
    .map(([key, schema]) => columnOf(entity, key, schema));
}
