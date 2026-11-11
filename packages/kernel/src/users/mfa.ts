import { z } from "zod";
import { authAdmin } from "../admin/auth-admin";
import { ADMIN_FEATURE, invalid, requireAdmin } from "../admin/common";
import { defineProcess } from "../process/define";
import { USERS_FEATURE } from "./entity";

// Two-step verification opt-out (design §22.19). The second step of the sign-in is a TOTP factor held by the identity
// provider; it is removed through the AuthAdmin adapter (rule 6), inside a process handler (rule 1), with a fresh step-up
// (rule 15) — so a user without a factor runs no sensitive process until they enrol again. Owner decision 2026-11-04: the
// second step is mandatory only where an administrator sets it on a member, an admin included (the access-token hook's
// `requires_mfa` claim reads `kernel.memberships.mfa_required`, 0056); no role requires it by itself.
//
// Order: everything in the database first, the identity provider last (the factors, then the user's sessions), and
// nothing outside the database in a dry run. When the process transaction fails after the factors were removed, the
// user simply enrols again (the sign-in asks for it when their role still requires it).

export const userMfaDisable = defineProcess({
  id: "kernel.user.mfa.disable",
  module: "kernel",
  kind: "update",
  feature: USERS_FEATURE,
  // Self-service: any active member, for themselves only (the handler acts on the caller and nobody else).
  permission: "none",
  sensitivity: "step-up",
  description: "Desactiva la verificación en dos pasos del propio usuario",
  input: z.object({}),
  output: z.object({ removed: z.number().int() }),
  auditInput: () => ({}),
  handler: async (ctx) => {
    // The factor belongs to the identity, not to a company: it is required when ANY active membership of the caller, in
    // any company, was set to require it (kernel.user_requires_mfa, 0056). Switching to another company does not let
    // them remove what the first one's administrator asked for.
    const [row] = await ctx.tx<{ required: boolean }[]>`select kernel.user_requires_mfa(${ctx.userId}) as required`;
    if (row?.required) throw invalid("mfa is required", "Un administrador exige tu verificación en dos pasos; pídele que deje de exigirla");
    if (ctx.dryRun) return { removed: 0 };
    const adapter = await authAdmin();
    const removed = await adapter.deleteFactors(ctx.userId);
    // Owner decision 2026-10-30 (design §22.19): the user's other sessions end too (Auth only downgrades them); the web
    // action then clears this one's cookies and shows the sign-in notice. Nothing removed, nothing ended.
    if (removed > 0) await adapter.signOutUser(ctx.userId);
    return { removed };
  },
});

const userMfaSetInput = z
  .object({
    userId: z.uuid(),
    /** Removes the member's factors: they enrol again at their next sign-in when their role requires it. */
    reset: z.boolean().optional(),
    /** Requires the member's second step (true) or stops requiring it (false). */
    required: z.boolean().optional(),
  })
  .refine((input) => input.reset !== undefined || input.required !== undefined, { message: "Indica qué cambiar" });

export const adminUserMfaSet = defineProcess({
  id: "kernel.admin.user.mfa.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Quita la verificación en dos pasos de un usuario de la empresa o decide si se le exige",
  input: userMfaSetInput,
  output: z.object({ userId: z.string(), removed: z.number().int(), required: z.boolean() }),
  auditInput: (input) => input,
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const [member] = await ctx.tx<{ id: string; mfa_required: boolean }[]>`
      select id, mfa_required from kernel.v_memberships where company_id = ${ctx.companyId} and user_id = ${input.userId}`;
    if (!member) throw invalid(`user ${input.userId} is not a member`, "El usuario no pertenece a la empresa");

    // The factor is the identity's: a user who also belongs to another organization keeps it (their other tenant's second
    // step would go with it). Asked before anything changes and before any adapter call (0029); the requirement, per
    // membership, is not refused for them.
    if (input.reset === true) {
      const [other] = await ctx.tx<{ other: boolean }[]>`select kernel.user_in_other_tenant(${input.userId}) as other`;
      if (other!.other) {
        throw invalid(`user ${input.userId} belongs to another tenant`, "Ese usuario pertenece también a otra organización; su segundo paso no se cambia desde aquí");
      }
    }

    // The requirement: the membership's row trigger audits the flag before and after.
    let required = member.mfa_required;
    if (input.required !== undefined && input.required !== member.mfa_required) {
      await ctx.tx`update kernel.memberships set mfa_required = ${input.required} where id = ${member.id}`;
      required = input.required;
    }

    // The reset removes the identity's factor, so it also ends the second step of the user's other companies; when one of
    // them still requires it (an administrator set it there), they enrol again at the next sign-in there. Never another
    // organization's: refused above.
    // The member's sessions end with it (owner decision 2026-10-30, design §22.19); the admin's own go on unless the
    // admin reset themselves.
    let removed = 0;
    if (input.reset === true && !ctx.dryRun) {
      const adapter = await authAdmin();
      removed = await adapter.deleteFactors(input.userId);
      if (removed > 0) await adapter.signOutUser(input.userId);
    }
    return { userId: input.userId, removed, required };
  },
});


// Passwords (owner decision 2026-11-04). The identity provider holds them (rule 6: through the AuthAdmin adapter); no
// password or hash is ever stored, logged or audited here, and the assistant has neither process (a password must not
// travel through the chat).

const newPassword = z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(72, "La contraseña admite hasta 72 caracteres");

export const userPasswordChange = defineProcess({
  id: "kernel.user.password.change",
  module: "kernel",
  kind: "update",
  feature: USERS_FEATURE,
  // Self-service: any active member, for themselves only. The current password is the proof of identity (no step-up).
  permission: "none",
  description: "Cambia la contraseña del propio usuario",
  input: z.object({ currentPassword: z.string().min(1), newPassword }),
  output: z.object({ changed: z.boolean() }),
  auditInput: () => ({}),
  handler: async (ctx, input) => {
    if (input.currentPassword === input.newPassword) throw invalid("same password", "La contraseña nueva debe ser distinta de la actual");
    const [user] = await ctx.tx<{ email: string }[]>`select email from kernel.users where id = ${ctx.userId}`;
    if (!user) throw invalid(`user ${ctx.userId} has no profile`, "No se encontró tu usuario");
    if (ctx.dryRun) return { changed: false };
    const adapter = await authAdmin();
    if (!(await adapter.verifyPassword(user.email, input.currentPassword))) throw invalid("wrong current password", "La contraseña actual no es correcta");
    await adapter.setPassword(ctx.userId, input.newPassword);
    return { changed: true };
  },
});

export const adminUserPasswordReset = defineProcess({
  id: "kernel.admin.user.password.reset",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Restablece la contraseña de un usuario de la empresa",
  input: z.object({ userId: z.uuid(), newPassword }),
  output: z.object({ userId: z.string() }),
  auditInput: (input) => ({ userId: input.userId }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const [member] = await ctx.tx<{ id: string }[]>`select id from kernel.v_memberships where company_id = ${ctx.companyId} and user_id = ${input.userId}`;
    if (!member) throw invalid(`user ${input.userId} is not a member`, "El usuario no pertenece a la empresa");
    // The password is the identity's, shared with the person's other organizations: not changed from here (as the factor).
    const [other] = await ctx.tx<{ other: boolean }[]>`select kernel.user_in_other_tenant(${input.userId}) as other`;
    if (other!.other) throw invalid(`user ${input.userId} belongs to another tenant`, "Ese usuario pertenece también a otra organización; su contraseña no se cambia desde aquí");
    if (ctx.dryRun) return { userId: input.userId };
    const adapter = await authAdmin();
    await adapter.setPassword(input.userId, input.newPassword);
    // Whoever held the old password is out: the person's sessions end (the admin's own go on, unless it is their own).
    await adapter.signOutUser(input.userId);
    return { userId: input.userId };
  },
});

/** The user's own processes of the users feature, registered beside kernel.user.consult. */
export const USER_MFA_PROCESSES = [userMfaDisable, userPasswordChange];
