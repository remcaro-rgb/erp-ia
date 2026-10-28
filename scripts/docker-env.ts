/**
 * Writes .env.docker from .env.docker.example with fresh local-only secrets (`pnpm docker:env`). Every value spelled
 * `generate` is replaced: POSTGRES_PASSWORD, JWT_SECRET and INTERNAL_TOKEN with random strings, ANON_KEY and
 * SERVICE_ROLE_KEY with HS256 JWTs signed with that JWT_SECRET (what Supabase's self-hosting guide derives). An existing
 * .env.docker is kept unless `--force` is given (its database volume was created with its password).
 */
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const target = join(root, ".env.docker");
const force = process.argv.includes("--force");

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** An HS256 JWT for a Supabase API key role, valid ten years. */
export function apiKey(role: "anon" | "service_role", secret: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * The asymmetric signing key of Auth, as hosted Supabase and `supabase start` use: user sessions are ES256 JWTs that
 * the app verifies locally against the public JWKS, while the API keys stay HS256 with JWT_SECRET. `JWT_KEYS` is
 * Auth's private key set; `JWT_JWKS` the verification set of PostgREST and Storage (the public key and the secret).
 */
export function signingKeys(jwtSecret: string): { JWT_KEYS: string; JWT_JWKS: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomUUID();
  const common = { kid, use: "sig", alg: "ES256", ext: true };
  const privateJwk = { ...privateKey.export({ format: "jwk" }), ...common, key_ops: ["sign", "verify"] };
  const publicJwk = { ...publicKey.export({ format: "jwk" }), ...common, key_ops: ["verify"] };
  return {
    JWT_KEYS: JSON.stringify([privateJwk]),
    JWT_JWKS: JSON.stringify({ keys: [publicJwk, { kty: "oct", k: b64url(jwtSecret) }] }),
  };
}

/** The example with every `generate` value replaced (JSON values single-quoted, literal for compose and sh). */
export function generateEnv(example: string): string {
  const jwtSecret = random(48);
  const values: Record<string, string> = {
    POSTGRES_PASSWORD: random(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: apiKey("anon", jwtSecret),
    SERVICE_ROLE_KEY: apiKey("service_role", jwtSecret),
    INTERNAL_TOKEN: random(32),
    ...signingKeys(jwtSecret),
  };
  return example.replace(/^([A-Z0-9_]+)=generate$/gm, (_line, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`no generator for ${name}`);
    return `${name}=${value.startsWith("[") || value.startsWith("{") ? `'${value}'` : value}`;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (existsSync(target) && !force) {
    console.log(".env.docker exists; kept (pass --force to regenerate, then recreate the stack with `pnpm docker:down`)");
  } else {
    writeFileSync(target, generateEnv(readFileSync(join(root, ".env.docker.example"), "utf8")), { mode: 0o600 });
    console.log("wrote .env.docker with fresh local-only secrets");
  }
}
