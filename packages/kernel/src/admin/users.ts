import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineProcess } from "../process/define";
import { validateEmail, validatePhone } from "../validation";
import { authAdmin } from "./auth-admin";
import { ADMIN_FEATURE, companyRole, invalid, requireAdmin } from "./common";

// Users created by the admin (design §6: "Created by the admin with at least e-mail, mobile and one role; photo optional;
// invitation by e-mail; 2FA activated by the user"). The person is invited through the AuthAdmin adapter (Supabase Auth
// with the service role) and becomes a member of the company with the chosen roles.
//
// One account belongs to one organization (tenant) in phase 1: an e-mail already used in another tenant is refused;
// a person of the same tenant (a member of another of its companies) is added without a new invitation and keeps
// their profile.
//
// Order: the Auth user is looked up or invited first (the identity provider is outside the database), then the profile,
// the membership and its roles are written in the process transaction. When that transaction fails after the
// invitation went out, the invited Auth user stays without a membership: inviting the same e-mail again finds that
// user and completes the membership, so a retry repairs it.

/** A small picture as a data URL (PNG, JPEG or WebP); the avatar shows it. */
const PHOTO = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "La foto debe ser una imagen PNG, JPEG o WebP")
  .max(400_000, "La foto supera 300 KB");

const userCreateInput = z
  .object({
    name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "Máximo 120 caracteres"),
    email: z.string().trim().toLowerCase(),
    mobileCc: z.string().trim().default("57"),
    mobile: z.string().trim(),
    roleIds: z.array(z.uuid()).min(1, "Elige al menos un rol"),
    photo: PHOTO.optional(),
  })
  .superRefine((input, issue) => {
    const email = validateEmail(input.email);
    if (email) issue.addIssue({ code: "custom", path: ["email"], message: email });
    const mobile = input.mobile === "" ? "El celular es obligatorio" : validatePhone(input.mobileCc, input.mobile);
    if (mobile) issue.addIssue({ code: "custom", path: ["mobile"], message: mobile });
  });

export const userCreate = defineProcess({
  id: "kernel.admin.user.create",
  module: "kernel",
  kind: "create",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Crea un usuario de la empresa con correo, celular y al menos un rol (foto opcional) y le envía la invitación por correo",
  input: userCreateInput,
  output: z.object({ id: z.string(), userId: z.string(), invited: z.boolean() }),
  auditInput: (input) => ({ ...input, photo: input.photo ? "(foto)" : undefined }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const roleIds = [...new Set(input.roleIds)];
    for (const roleId of roleIds) await companyRole(ctx, roleId);

    const adapter = await authAdmin();
    const existing = await adapter.getUserByEmail(input.email);
    if (existing) {
      // One organization per account (phase 1): an e-mail of another tenant is refused before anything of it is read.
      const [other] = await ctx.tx<{ other: boolean }[]>`select kernel.user_in_other_tenant(${existing.id}) as other`;
      if (other!.other) throw invalid(`${input.email} belongs to another tenant`, "Ese correo ya pertenece a otra organización");
      const [member] = await ctx.tx`select 1 from kernel.memberships where company_id = ${ctx.companyId} and user_id = ${existing.id}`;
      if (member) throw invalid(`${input.email} is already a member`, "Ya existe un usuario con ese correo en la empresa");
    }
    // A dry run reaches nothing outside the database: no invitation goes out.
    if (ctx.dryRun && !existing) return { id: randomUUID(), userId: randomUUID(), invited: true };
    const userId = existing?.id ?? (await adapter.inviteUserByEmail(input.email, { fullName: input.name })).id;

    await ctx.tx`select kernel.admin_register_user(${userId}, ${input.email}, ${input.name}, ${input.mobileCc}, ${input.mobile}, ${input.photo ?? null})`;
    const [membership] = await ctx.tx<{ id: string }[]>`
      insert into kernel.memberships (user_id, company_id) values (${userId}, ${ctx.companyId}) returning id`;
    for (const roleId of roleIds) {
      await ctx.tx`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${roleId})`;
    }
    return { id: membership!.id, userId, invited: !existing };
  },
});

export const USER_PROCESSES = [userCreate];
