import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { countryPackOf } from "../registry/labels";
import { ADMIN_FEATURE, invalid, requireAdmin } from "./common";
import { moduleStates } from "./modules-state";

// Modules on and off per company (design §5.12, rule 4). Switching a module off keeps its data and events; its
// processes stop being entitled, so its menus, its exports and the assistant's tools of it disappear at once. The
// manifests' dependencies hold both ways: a module needs its dependencies on, and a module another enabled module
// depends on cannot go off (support depends on core).

const MODULE_ID = z.string().regex(/^[a-z][a-z0-9_]*$/, "Identificador de módulo inválido");
const output = z.object({ moduleId: z.string(), enabled: z.boolean() });

export const moduleEnable = defineProcess({
  id: "kernel.admin.module.enable",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Activa para la empresa un módulo contratado; sus dependencias deben estar activas",
  input: z.object({ moduleId: MODULE_ID }),
  output,
  handler: async (ctx, { moduleId }) => {
    await requireAdmin(ctx);
    if (moduleId === "kernel" || !ctx.registry.hasModule(moduleId)) throw invalid(`unknown module ${moduleId}`, `El módulo ${moduleId} no existe`);
    const states = await moduleStates(ctx.tx, ctx.registry);
    const state = states.find((m) => m.id === moduleId)!;
    if (!state.purchased) throw new ProcessError("not_entitled", `module ${moduleId} is not part of the tenant's plan`, { details: ["Tu empresa no tiene contratado este módulo"] });
    const missing = state.dependsOn.find((dep) => !states.find((m) => m.id === dep)?.enabled);
    if (missing) throw invalid(`module ${moduleId} requires ${missing}`, `Primero activa el módulo ${missing}, del que depende`);
    // A module that adds account roles needs the company's country pack to map every one of them (design §5.3).
    const roles = ctx.registry.module(moduleId).accountRoles ?? [];
    if (roles.length > 0) {
      const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
      const mapped = new Set(countryPackOf(company?.country_code)?.defaultRoleMappings?.().map((m) => m.role));
      const unmapped = roles.filter((role) => !mapped.has(role));
      if (unmapped.length > 0) throw invalid(`country pack does not map roles ${unmapped.join(", ")}`, `El pack del país no mapea los roles contables: ${unmapped.join(", ")}`);
    }
    await ctx.tx`
      insert into kernel.company_modules (company_id, module_id, enabled, enabled_at)
      values (${ctx.companyId}, ${moduleId}, true, now())
      on conflict (company_id, module_id)
      do update set enabled = true, enabled_at = case when kernel.company_modules.enabled then kernel.company_modules.enabled_at else now() end`;
    // The admin role runs everything by definition (kernel.can_run_process); every other role gets the module's
    // consults, the baseline a role created while the module was on would have (kernel.seed_role_defaults).
    const consults = ctx.registry
      .processes({ module: moduleId })
      .filter((p) => p.kind === "consult")
      .map((p) => p.id);
    await ctx.tx`
      insert into kernel.process_permissions (company_id, role_id, process_id)
      select r.company_id, r.id, p.id
      from kernel.roles r cross join unnest(${consults}::text[]) as p(id)
      where r.company_id = ${ctx.companyId} and not (r.is_system and r.name = 'admin')
      on conflict (company_id, role_id, process_id) do nothing`;
    return { moduleId, enabled: true };
  },
});

export const moduleDisable = defineProcess({
  id: "kernel.admin.module.disable",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Desactiva un módulo para la empresa sin borrar sus datos; no se puede mientras otro módulo activo dependa de él",
  input: z.object({ moduleId: MODULE_ID }),
  output,
  handler: async (ctx, { moduleId }) => {
    await requireAdmin(ctx);
    if (moduleId === "kernel") throw invalid("the kernel cannot be disabled", "El núcleo de la plataforma no se puede desactivar");
    if (!ctx.registry.hasModule(moduleId)) throw invalid(`unknown module ${moduleId}`, `El módulo ${moduleId} no existe`);
    const states = await moduleStates(ctx.tx, ctx.registry);
    const dependent = states.find((m) => m.enabled && m.dependsOn.includes(moduleId));
    if (dependent) throw invalid(`module ${dependent.id} depends on ${moduleId}`, `El módulo ${dependent.id} depende de este; desactívalo primero`);
    await ctx.tx`
      insert into kernel.company_modules (company_id, module_id, enabled, enabled_at)
      values (${ctx.companyId}, ${moduleId}, false, now())
      on conflict (company_id, module_id) do update set enabled = false`;
    return { moduleId, enabled: false };
  },
});

export const MODULE_PROCESSES = [moduleEnable, moduleDisable];
