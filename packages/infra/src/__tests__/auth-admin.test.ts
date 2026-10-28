import { describe, expect, it } from "vitest";
import { SupabaseAuthAdmin, type AuthAdmin } from "../auth-admin";

type Call = [string, ...unknown[]];

/** An Auth admin client that records the calls and answers from `users` (pages of `perPage`). */
function fakeClient(options: { users?: { id: string; email: string }[]; inviteError?: string; perPage?: number } = {}) {
  const calls: Call[] = [];
  const users = options.users ?? [];
  const admin = {
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
});
