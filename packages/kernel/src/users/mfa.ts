import { z } from "zod";
import { authAdmin } from "../admin/auth-admin";
import { ADMIN_FEATURE, invalid, requireAdmin } from "../admin/common";
import { defineProcess } from "../process/define";
import { USERS_FEATURE } from "./entity";

// Two-step verification opt-out (design §22.19). The second step of the sign-in is a TOTP factor held by the identity
// provider; it is removed through the AuthAdmin adapter (rule 6), inside a process handler (rule 1), with a fresh step-up
// (rule 15) — so a user without a factor runs no sensitive process until they enrol again. The system admin role requires
// the second step (the access-token hook's `requires_mfa` claim) unless the admin exempted the member
// (`kernel.memberships.mfa_exempt`, 0028).
//
// Order: everything in the database first, the identity provider last, and nothing outside the database in a dry run.
// When the process transaction fails after the factors were removed, the user simply enrols again (the sign-in asks for
// it when their role still requires it).

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
    // The same predicate as the access-token hook's `requires_mfa` (0028), read live from the caller's membership in the
    // active company (kernel.memberships is readable by every member; kernel.v_memberships is the admin's view only).
    const [row] = await ctx.tx<{ required: boolean }[]>`
      select exists (
        select 1
        from kernel.memberships m
        join kernel.membership_roles mr on mr.membership_id = m.id
        join kernel.roles r on r.id = mr.role_id
        where m.user_id = ${ctx.userId} and m.company_id = ${ctx.companyId}
          and r.company_id = m.company_id and r.is_system and r.name = 'admin'
          and not m.mfa_exempt
      ) as required`;
    if (row?.required) throw invalid("role requires mfa", "Tu rol exige la verificación en dos pasos; pídele a un administrador que te exima");
    if (ctx.dryRun) return { removed: 0 };
    const removed = await (await authAdmin()).deleteFactors(ctx.userId);
    return { removed };
  },
});

const userMfaSetInput = z
  .object({
    userId: z.uuid(),
    /** Removes the member's factors: they enrol again at their next sign-in when their role requires it. */
    reset: z.boolean().optional(),
    /** Exempts the member from the system admin role's requirement (true) or lifts the exemption (false). */
    exempt: z.boolean().optional(),
  })
  .refine((input) => input.reset !== undefined || input.exempt !== undefined, { message: "Indica qué cambiar" });

export const adminUserMfaSet = defineProcess({
  id: "kernel.admin.user.mfa.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Quita la verificación en dos pasos de un usuario de la empresa o lo exime de la que exige su rol",
  input: userMfaSetInput,
  output: z.object({ userId: z.string(), removed: z.number().int(), exempt: z.boolean() }),
  auditInput: (input) => input,
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const [member] = await ctx.tx<{ id: string; mfa_exempt: boolean }[]>`
      select id, mfa_exempt from kernel.v_memberships where company_id = ${ctx.companyId} and user_id = ${input.userId}`;
    if (!member) throw invalid(`user ${input.userId} is not a member`, "El usuario no pertenece a la empresa");

    // The exemption: the membership's row trigger audits the flag before and after.
    let exempt = member.mfa_exempt;
    if (input.exempt !== undefined && input.exempt !== member.mfa_exempt) {
      await ctx.tx`update kernel.memberships set mfa_exempt = ${input.exempt} where id = ${member.id}`;
      exempt = input.exempt;
    }

    let removed = 0;
    if (input.reset === true && !ctx.dryRun) removed = await (await authAdmin()).deleteFactors(input.userId);
    return { userId: input.userId, removed, exempt };
  },
});

/** The user's own processes of the users feature, registered beside kernel.user.consult. */
export const USER_MFA_PROCESSES = [userMfaDisable];
