import "server-only";
import { randomUUID } from "node:crypto";
import { getServiceDb, writeAudit, type JwtClaims } from "@erp/kernel";

// Audit rows of the session events that are not process runs (design §5.5, rule 16): who signed in and
// how, and which company they moved to. Written through `writeAudit` with origin `ui`, in the user's active
// company, on a connection of the server (the user has no process to run before a session exists).

/** `auth.login`: a completed sign-in (password, then the second step where the account has one). */
export async function recordLogin(claims: JwtClaims, input: { remember: boolean; mfa: "totp" | "none" }): Promise<void> {
  await getServiceDb().begin((tx) =>
    writeAudit(tx, {
      companyId: claims.active_company_id,
      actorUserId: claims.sub,
      origin: "ui",
      processId: "auth.login",
      entity: "kernel.users",
      rowId: claims.sub,
      action: "insert",
      input,
      chainId: randomUUID(),
    }),
  );
}

/** `auth.company.switch`: the user moved their session to another of their companies. */
export async function recordCompanySwitch(claims: JwtClaims, from: string): Promise<void> {
  await getServiceDb().begin((tx) =>
    writeAudit(tx, {
      companyId: claims.active_company_id,
      actorUserId: claims.sub,
      origin: "ui",
      processId: "auth.company.switch",
      entity: "kernel.users",
      rowId: claims.sub,
      action: "update",
      input: { from, to: claims.active_company_id },
      diff: { active_company_id: { old: from, new: claims.active_company_id } },
      chainId: randomUUID(),
    }),
  );
}
