import { z } from "zod";
import { defineProcess } from "../process/define";

// The user's own preferences (design §19a): theme, open tabs, home layout. Self-service: any member of the
// active company sets and reads their own (`permission: "none"`), always through the audited pipeline.

const FEATURE = "kernel.user_prefs";

/** `theme`, `tabs`, `home_layout`, `grid.core_party.columns`: lowercase snake_case segments joined by dots. */
export const USER_PREF_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
/** Upper bound of one stored value, serialized (the table enforces the same). */
export const MAX_USER_PREF_BYTES = 65_536;

const key = z.string().max(64).regex(USER_PREF_KEY);
const value = z.json().refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_USER_PREF_BYTES, {
  message: `value larger than ${MAX_USER_PREF_BYTES} bytes`,
});

export const userPrefSet = defineProcess({
  id: "kernel.user_prefs.set",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  permission: "none",
  description: "Guarda una preferencia del usuario (tema, pestañas abiertas, diseño del inicio) en la empresa activa",
  input: z.object({ key, value }),
  output: z.object({ key: z.string() }),
  handler: async (ctx, input) => {
    await ctx.tx`
      insert into kernel.user_prefs (user_id, company_id, key, value)
      values (${ctx.userId}, ${ctx.companyId}, ${input.key}, ${ctx.tx.json(input.value as never)})
      on conflict (user_id, company_id, key) do update set value = excluded.value, updated_at = now()`;
    return { key: input.key };
  },
});

export const userPrefGet = defineProcess({
  id: "kernel.user_prefs.get",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  permission: "none",
  description: "Consulta una preferencia del usuario en la empresa activa; null cuando no la ha guardado",
  input: z.object({ key }),
  output: z.object({ key: z.string(), value: z.json().nullable() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ value: unknown }[]>`
      select value from kernel.user_prefs
      where user_id = ${ctx.userId} and company_id = ${ctx.companyId} and key = ${input.key}`;
    return { key: input.key, value: (row?.value ?? null) as z.infer<ReturnType<typeof z.json>> | null };
  },
});

export const USER_PREF_PROCESSES = [userPrefSet, userPrefGet];
