import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateEnv } from "../docker-env";

// The compose stack's secrets are generated per machine (Task 21): nothing real is committed, .env.docker.example
// only says `generate`.

const example = readFileSync(join(__dirname, "..", "..", ".env.docker.example"), "utf8");
const parse = (text: string) => Object.fromEntries(text.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
const verifies = (jwt: string, secret: string) => {
  const [header, payload, signature] = jwt.split(".");
  return createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url") === signature;
};

describe("docker env", () => {
  it("the committed example holds no secret, only `generate`", () => {
    const env = parse(example);
    for (const name of ["POSTGRES_PASSWORD", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY", "INTERNAL_TOKEN", "WORKFLOW_INTERNAL_TOKEN", "JWT_KEYS", "JWT_JWKS"]) expect(env[name]).toBe("generate");
  });

  it("generates every secret, the API keys signed with the generated JWT secret", () => {
    const env = parse(generateEnv(example));
    expect(Object.values(env)).not.toContain("generate");
    expect(env.JWT_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(env.INTERNAL_TOKEN!.length).toBeGreaterThanOrEqual(32);
    // 32 random bytes, base64url: the edge's token is as strong as the internal one.
    expect(env.WORKFLOW_INTERNAL_TOKEN!.length).toBeGreaterThanOrEqual(43);
    expect(claims(env.ANON_KEY!)).toMatchObject({ role: "anon", iss: "supabase" });
    expect(claims(env.SERVICE_ROLE_KEY!)).toMatchObject({ role: "service_role", iss: "supabase" });
    expect(verifies(env.ANON_KEY!, env.JWT_SECRET!)).toBe(true);
    expect(verifies(env.SERVICE_ROLE_KEY!, env.JWT_SECRET!)).toBe(true);
    expect(env.DB_HOST_PORT).toBe("56322");
  });

  it("generates Auth's ES256 key: the private set for Auth, the public key and the secret for PostgREST and Storage", () => {
    const env = parse(generateEnv(example));
    const unquote = (value: string) => JSON.parse(value.replace(/^'|'$/g, "")) as unknown;
    const [privateKey] = unquote(env.JWT_KEYS!) as Record<string, unknown>[];
    const { keys } = unquote(env.JWT_JWKS!) as { keys: Record<string, unknown>[] };
    expect(privateKey).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", key_ops: ["sign", "verify"], d: expect.any(String) });
    expect(keys[0]).toMatchObject({ kty: "EC", kid: privateKey!.kid, x: privateKey!.x, y: privateKey!.y, key_ops: ["verify"] });
    expect(keys[0]).not.toHaveProperty("d");
    expect(keys[1]).toEqual({ kty: "oct", k: Buffer.from(env.JWT_SECRET!).toString("base64url") });
  });

  it("two runs never share a secret", () => {
    const a = parse(generateEnv(example));
    const b = parse(generateEnv(example));
    for (const name of ["POSTGRES_PASSWORD", "JWT_SECRET", "INTERNAL_TOKEN", "WORKFLOW_INTERNAL_TOKEN"]) expect(a[name]).not.toBe(b[name]);
    expect(a.WORKFLOW_INTERNAL_TOKEN).not.toBe(a.INTERNAL_TOKEN);
  });
});
