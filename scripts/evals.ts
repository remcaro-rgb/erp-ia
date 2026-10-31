/**
 * The model-backed assistant evaluation (rule 30, design §7.1): `pnpm evals [--allow-fail]`. Runs every Spanish prompt of
 * `packages/agent/src/__tests__/evals/*.json` as Laura (the demo company's admin) against the chat model of
 * `kernel.model_policies`, for one step each, with the real system prompt and her tools; no tool executes. LOCAL USE ONLY:
 * it needs the demo company (`DEMO_SEED=1 pnpm db:seed`) and the gateway key, or `AGENT_MODEL=mock` for the plumbing.
 *
 * Prints a table, writes `eval-report.json` and exits 1 unless every core case passes and 90 % overall do (owner
 * 2026-10-30). `--allow-fail` keeps the exit code at 0, for the mock run, which cannot answer every prompt.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentModelFactory, EVAL_PASS_RATE, evalsPassed, runEvals, setAgentModelFactory, type EvalCase, type EvalReport } from "@erp/agent";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { getServiceDb, kernelModule, loadModules, registerCountryPack, Registry } from "@erp/kernel";
import { LAURA } from "./demo/accounts";
import { assertSeedAllowed, seedEnv, signIn } from "./seed";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CASES_DIR = join(ROOT, "packages", "agent", "src", "__tests__", "evals");

export function loadCases(dir = CASES_DIR): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { cases: EvalCase[] }).cases);
}

/** The report as a text table plus the verdict line, for the job log. */
export function summarize(report: EvalReport): string {
  const rows = report.cases.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.tier.padEnd(8)} ${c.id}${c.why ? `  — ${c.why}` : ""}`);
  const passed = report.cases.filter((c) => c.pass).length;
  return [
    `Modelo: ${report.model}`,
    ...rows,
    `${passed}/${report.cases.length} (${(report.passRate * 100).toFixed(0)} %) · casos core: ${report.corePass ? "todos pasan" : "hay fallos"} · umbral ${EVAL_PASS_RATE * 100} % → ${evalsPassed(report) ? "APRUEBA" : "NO APRUEBA"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const allowFail = process.argv.includes("--allow-fail");
  const env = seedEnv(process.env);
  assertSeedAllowed(env, process.env);
  process.env.DATABASE_URL = env.databaseUrl;
  setAgentModelFactory(agentModelFactory(process.env));

  const sql = getServiceDb();
  try {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, accounting, support]);
    registerCountryPack(co);
    const laura = await signIn(sql, env, LAURA);
    // Laura's session only supplies her claims: no process runs.
    const report = await runEvals({ sql, deps: { sql, registry }, caller: laura.caller, registry, cases: loadCases() });
    writeFileSync(join(process.cwd(), "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(summarize(report));
    if (!evalsPassed(report) && !allowFail) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import("./env");
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
