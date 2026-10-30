import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { adminUserMfaSet } from "../users/mfa";
import { DEFAULT_PHONE_CC, validateEmail, validatePhone } from "../validation";
import { authAdmin } from "./auth-admin";
import { ADMIN_FEATURE, companyRole, invalid, requireAdmin } from "./common";
import { setUserRoles } from "./roles";

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

// Editable users (design §22.16): the admin changes a member's name, mobile, photo, locale, roles and active state. Only
// what the input names changes. Deactivating (`active: false`) sets the membership inactive and revokes nothing else: the
// roles and the history stay, and `active: true` restores the access as it was. While inactive the member runs nothing
// (runProcess's gate, kernel.membership_inactive) and cannot sign in. An admin never deactivates themselves, and the
// company always keeps an active admin (0027's trigger, whoever writes).

/** The languages the application has catalogues for (`packages/i18n`), as a user's locale. */
export const USER_LOCALES = ["es-419", "en"] as const;

const CHANGES = ["name", "mobileCc", "mobile", "photo", "locale", "roleIds", "active"] as const;

const userUpdateInput = z
  .object({
    userId: z.uuid(),
    name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "Máximo 120 caracteres").optional(),
    mobileCc: z.string().trim().optional(),
    mobile: z.string().trim().optional(),
    /** A new picture, or null to remove it. */
    photo: PHOTO.nullable().optional(),
    locale: z.enum(USER_LOCALES, "Elige un idioma de la lista").optional(),
    roleIds: z.array(z.uuid()).min(1, "Elige al menos un rol").optional(),
    active: z.boolean().optional(),
  })
  .superRefine((input, issue) => {
    if (!CHANGES.some((key) => input[key] !== undefined)) issue.addIssue({ code: "custom", path: [], message: "Indica al menos un dato que cambie" });
    if (input.mobileCc !== undefined && input.mobile === undefined) issue.addIssue({ code: "custom", path: ["mobile"], message: "Indica el celular con su indicativo" });
    // With its country code the mobile is checked here; without one, against the stored code (in the handler).
    if (input.mobile === "") issue.addIssue({ code: "custom", path: ["mobile"], message: "El celular es obligatorio" });
    else if (input.mobile !== undefined && input.mobileCc !== undefined) {
      const mobile = validatePhone(input.mobileCc, input.mobile);
      if (mobile) issue.addIssue({ code: "custom", path: ["mobile"], message: mobile });
    }
  });

/** A photo as the audit keeps it: whether there is one, never the picture. */
const photoMark = (photo: string | null | undefined) => (photo ? "(foto)" : null);

export const userUpdate = defineProcess({
  id: "kernel.admin.user.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Cambia el nombre, el celular, la foto, el idioma, los roles o el estado (activo o desactivado) de un usuario de la empresa; desactivarlo le quita el acceso sin borrar su historial",
  input: userUpdateInput,
  output: z.object({ id: z.string(), membershipId: z.string(), active: z.boolean() }),
  auditInput: (input) => ({ ...input, photo: input.photo === undefined ? undefined : photoMark(input.photo) }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    // A change that can leave the company without an active admin locks the company first (kernel.lock_active_admins),
    // before any membership row: the same order (company, then membership) as every other such change, so two of them
    // wait for each other instead of deadlocking. 0027's trigger stays the last line of defence.
    if (input.active === false || input.roleIds !== undefined) await ctx.tx`select kernel.lock_active_admins()`;
    const [member] = await ctx.tx<{ id: string; is_active: boolean; full_name: string | null; mobile_cc: string | null; mobile: string | null; photo: string | null; locale: string }[]>`
      select id, is_active, full_name, mobile_cc, mobile, photo, locale
      from kernel.v_memberships where company_id = ${ctx.companyId} and user_id = ${input.userId}`;
    if (!member) throw invalid(`user ${input.userId} is not a member`, "El usuario no pertenece a la empresa");
    if (input.active === false && input.userId === ctx.userId) throw invalid("the admin keeps their own account active", "No puedes desactivar tu propia cuenta");

    // A mobile sent without its country code keeps the stored one (Colombia's only for a user who has none yet).
    const mobileCc = input.mobile !== undefined ? (input.mobileCc ?? member.mobile_cc ?? DEFAULT_PHONE_CC) : undefined;
    if (input.mobile !== undefined && input.mobileCc === undefined) {
      const problem = validatePhone(mobileCc!, input.mobile);
      if (problem) throw new ProcessError("invalid_input", "invalid mobile", { details: [{ path: ["mobile"], message: problem }] });
    }

    // The profile (kernel.users, through kernel.admin_update_user): the audit records each changed field before and after.
    const profile = {
      full_name: input.name,
      mobile_cc: mobileCc,
      mobile: input.mobile,
      locale: input.locale,
    };
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    for (const [column, value] of Object.entries(profile)) {
      const old = member[column as keyof typeof profile];
      if (value !== undefined && value !== old) diff[column] = { old, new: value };
    }
    if (input.photo !== undefined && input.photo !== member.photo) diff.photo = { old: photoMark(member.photo), new: photoMark(input.photo) };
    if (Object.keys(diff).length > 0) {
      await ctx.tx`select kernel.admin_update_user(${input.userId}, ${profile.full_name ?? null}, ${profile.mobile_cc ?? null}, ${profile.mobile ?? null}, ${input.photo !== undefined}, ${input.photo ?? null}, ${profile.locale ?? null})`;
    }

    if (input.roleIds !== undefined) await setUserRoles(ctx, { userId: input.userId, roleIds: input.roleIds });

    // The state: only the flag; the roles and the history stay (the membership's row change is audited by its trigger).
    let active = member.is_active;
    if (input.active !== undefined && input.active !== member.is_active) {
      await ctx.tx`update kernel.memberships set is_active = ${input.active} where id = ${member.id}`;
      diff.is_active = { old: member.is_active, new: input.active };
      active = input.active;
    }

    if (Object.keys(diff).length > 0) await ctx.audit({ entity: "kernel.users", rowId: input.userId, action: "update", diff });
    return { id: input.userId, membershipId: member.id, active };
  },
});

// The second step of a member's sign-in (design §22.19): kernel.admin.user.mfa.set, in ../users/mfa.ts beside the user's own.
export const USER_PROCESSES = [userCreate, userUpdate, adminUserMfaSet];
