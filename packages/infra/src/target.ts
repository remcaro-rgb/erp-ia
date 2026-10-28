// Where this build runs (rule 6, design §21): `ERP_TARGET=vercel|docker`, default `vercel`. Every infra interface has
// one implementation per target and the factories in `index.ts` pick it from this value; nothing else in the code
// branches on the platform.

export type Target = "vercel" | "docker";

export type Env = Record<string, string | undefined>;

const TARGETS: readonly Target[] = ["vercel", "docker"];

/** The deployment target from `ERP_TARGET` (unset or empty: `vercel`). Any other value is a configuration error. */
export function target(env: Env = process.env): Target {
  const value = env.ERP_TARGET?.trim();
  if (!value) return "vercel";
  if ((TARGETS as readonly string[]).includes(value)) return value as Target;
  throw new Error(`ERP_TARGET must be one of ${TARGETS.join(", ")} (got "${value}")`);
}

/** The value of `name`, or an error that names the variable and the target that needs it. */
export function required(env: Env, name: string, why: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required ${why}`);
  return value;
}
