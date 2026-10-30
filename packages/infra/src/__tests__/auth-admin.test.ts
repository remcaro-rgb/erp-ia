import { describe, expect, it } from "vitest";
import { SupabaseAuthAdmin, type AuthAdmin } from "../auth-admin";

type Call = [string, ...unknown[]];

/** An Auth admin client that records the calls and answers from `users` (pages of `perPage`). */
function fakeClient(
  options: { users?: { id: string; email: string }[]; inviteError?: string; perPage?: number; factors?: { id: string; factor_type: string }[]; factorError?: string } = {},
) {
  const calls: Call[] = [];
  const users = options.users ?? [];
  const admin = {
    mfa: {
      listFactors: async (params: { userId: string }) => {
        calls.push(["listFactors", params]);
        return options.factorError ? { data: null, error: { message: options.factorError } } : { data: { factors: options.factors ?? [] }, error: null };
      },
      deleteFactor: async (params: { id: string; userId: string }) => {
        calls.push(["deleteFactor", params]);
        return { data: { id: params.id }, error: null };
      },
    },
    inviteUserByEmail: async (...args: unknown[]) => {
      calls.push(["inviteUserByEmail", ...args]);
      return options.inviteError ? { data: { user: null }, error: { message: options.inviteError } } : { data: { user: { id: "new-user", email: args[0] } }, error: null };
    },
    listUsers: async (params: { page: number; perPage: number }) => {
      calls.push(["listUsers", params]);
      const start = (params.page - 1) * params.perPage;
      return { data: { users: users.slice(start, start + params.perPage) }, error: null };
    },
  };
  return { client: { auth: { admin } } as unknown as ConstructorParameters<typeof SupabaseAuthAdmin>[0], calls };
}

describe("SupabaseAuthAdmin", () => {
  it("invites by e-mail with the user's name as metadata and answers the new user's id", async () => {
    const { client, calls } = fakeClient();
    const auth: AuthAdmin = new SupabaseAuthAdmin(client);
    await expect(auth.inviteUserByEmail("ana@cafe.co", { fullName: "Ana Ruiz" })).resolves.toEqual({ id: "new-user" });
    expect(calls).toEqual([["inviteUserByEmail", "ana@cafe.co", { data: { full_name: "Ana Ruiz" } }]]);
  });

  it("reports a failed invitation", async () => {
    const { client } = fakeClient({ inviteError: "rate limit" });
    await expect(new SupabaseAuthAdmin(client).inviteUserByEmail("ana@cafe.co", { fullName: "Ana" })).rejects.toThrow(/could not invite ana@cafe.co: rate limit/);
  });

  it("finds a user by e-mail across pages, ignoring case, or answers null", async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, email: `u${i}@cafe.co` }));
    const { client, calls } = fakeClient({ users });
    const auth = new SupabaseAuthAdmin(client, 2);
    await expect(auth.getUserByEmail("U3@Cafe.co")).resolves.toEqual({ id: "u3" });
    expect(calls).toEqual([
      ["listUsers", { page: 1, perPage: 2 }],
      ["listUsers", { page: 2, perPage: 2 }],
    ]);
    await expect(auth.getUserByEmail("nadie@cafe.co")).resolves.toBeNull();
  });

  it("removes every TOTP factor of a user (and no other kind) and answers how many", async () => {
    const factors = [
      { id: "f1", factor_type: "totp" },
      { id: "f2", factor_type: "phone" },
      { id: "f3", factor_type: "totp" },
    ];
    const { client, calls } = fakeClient({ factors });
    await expect(new SupabaseAuthAdmin(client).deleteFactors("user-1")).resolves.toBe(2);
    expect(calls).toEqual([
      ["listFactors", { userId: "user-1" }],
      ["deleteFactor", { id: "f1", userId: "user-1" }],
      ["deleteFactor", { id: "f3", userId: "user-1" }],
    ]);
  });

  it("answers 0 for a user without a factor and reports a failed listing", async () => {
    await expect(new SupabaseAuthAdmin(fakeClient().client).deleteFactors("user-1")).resolves.toBe(0);
    await expect(new SupabaseAuthAdmin(fakeClient({ factorError: "boom" }).client).deleteFactors("user-1")).rejects.toThrow(/could not list the factors of user-1: boom/);
  });

  it("ends a user's sessions through the server's revoker (Auth's admin API signs out by JWT only), without touching the client", async () => {
    const { client, calls } = fakeClient();
    const revoked: string[] = [];
    await new SupabaseAuthAdmin(client, 1000, async (userId) => void revoked.push(userId)).signOutUser("user-1");
    expect(revoked).toEqual(["user-1"]);
    expect(calls).toEqual([]);
  });

  it("refuses to sign a user out without a revoker rather than pretending it did", async () => {
    await expect(new SupabaseAuthAdmin(fakeClient().client).signOutUser("user-1")).rejects.toThrow(/could not end the sessions of user-1: no session revoker/);
  });

  it("fromEnv hands the revoker to the adapter", async () => {
    const revoked: string[] = [];
    const auth = SupabaseAuthAdmin.fromEnv({ SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "key" }, { revokeSessions: async (userId) => void revoked.push(userId) });
    await auth.signOutUser("user-2");
    expect(revoked).toEqual(["user-2"]);
  });
});
