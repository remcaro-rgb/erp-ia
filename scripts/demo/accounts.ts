// The demo company and its accounts (Task 22), shared by `supabase/seed.sql` (the ids), `pnpm db:seed` and the smoke
// test. LOCAL USE ONLY: the passwords and the TOTP secret below are public, they exist so a developer can sign in to a
// local or Docker test stack. `pnpm db:seed` runs only with DEMO_SEED=1 and against a local stack (scripts/seed.ts).

/** Fixed ids (UUID v7 layout) so the SQL seed and the TypeScript seed name the same rows. */
export const DEMO_TENANT_ID = "019a2c4e-0000-7000-8000-00000000d001";
export const DEMO_COMPANY_ID = "019a2c4e-0000-7000-8000-00000000d002";

export const DEMO_ROLE_IDS = {
  admin: "019a2c4e-0000-7000-8000-00000000d101",
  gerente_comercial: "019a2c4e-0000-7000-8000-00000000d102",
  contador: "019a2c4e-0000-7000-8000-00000000d103",
  cajero: "019a2c4e-0000-7000-8000-00000000d104",
} as const;

export type DemoRole = keyof typeof DEMO_ROLE_IDS;

export const DEMO_COMPANY = { legalName: "Café del Norte S.A.S.", tradeName: "Café del Norte", taxId: "900373115", checkDigit: "3" } as const;

export interface DemoAccount {
  email: string;
  password: string;
  fullName: string;
  roles: DemoRole[];
  /** Base32 TOTP secret enrolled for the account (authenticator apps accept it as a manual key). */
  totpSecret?: string;
  /** Mobile (Colombia, without +57): kernel.admin.user.create asks for one. */
  mobile: string;
}

/** Laura administers the company (admin + gerente comercial) and signs in with her password and a TOTP code. */
export const LAURA: DemoAccount = {
  email: "laura@demo.local",
  password: "demo-laura-2026",
  fullName: "Laura Méndez",
  roles: ["admin", "gerente_comercial"],
  mobile: "3157654321",
  totpSecret: "CAFEDELNORTEDEMOLAURATOTPSECRETX",
};

/** Marcela is a cashier: she consults, never sees the credit limit and has no second step enrolled. */
export const MARCELA: DemoAccount = {
  email: "marcela@demo.local",
  password: "demo-marcela-2026",
  fullName: "Marcela Rojas",
  roles: ["cajero"],
  mobile: "3165550123",
};

export const DEMO_ACCOUNTS = [LAURA, MARCELA] as const;
