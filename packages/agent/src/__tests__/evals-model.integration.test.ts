import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "../../../modules/accounting/src/__tests__/helpers";
import { agentModelFactory, MOCK_AGENT_MODEL } from "../runtime/mock-agent-model";
import { MissingModelPolicy } from "../runtime/model-policy";
import { setAgentModelFactory } from "../runtime/policy-model";
import { runEvals } from "../evals/run-evals";
import type { EvalCase } from "../evals/match";

// The model-backed evaluation run on the local stack with AGENT_MODEL=mock (rule 30): the plumbing every push exercises
// at no cost. The nightly job (.github/workflows/evals.yml) runs the same runner against the policy model.

const dir = join(dirname(fileURLToPath(import.meta.url)), "evals");
const cases: EvalCase[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { cases: EvalCase[] }).cases);

let h: AccountingHarness;
let year: number;
const run = () => ({ sql: h.sql, deps: h.deps, caller: h.admin, registry: h.deps.registry, cases });

beforeAll(async () => {
  h = await accountingHarness();
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["kernel.data.query"]);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  const entry = async (month: number, description: string, lines: { code: string; debit?: number; credit?: number; cc?: string }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-${String(month).padStart(2, "0")}-10`,
      description,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  };
  // The ledger the data.query cases read: a sale named by its invoice number and an expense of the month the case asks for.
  await entry(1, "Factura de venta FE-1001", [{ code: "111005", debit: 1_000 }, { code: "413595", credit: 1_000, cc }]);
  await entry(1, "Gastos de administración", [{ code: "510506", debit: 800, cc }, { code: "111005", credit: 800 }]);
}, 180_000);

afterEach(() => setAgentModelFactory(undefined));
afterAll(async () => {
  await h.sql`delete from kernel.llm_usage where company_id = ${h.companyId}`;
  await h.cleanup();
});

describe("evals-model", () => {
  it("runs the set with the mock model: the case the mock knows ('gastos de octubre por centro de costo') passes, the report names the model 'mock/agent', usage rows are recorded", async () => {
    setAgentModelFactory(agentModelFactory({ AGENT_MODEL: "mock" }));
    const report = await runEvals(run());
    expect(report.model).toBe(MOCK_AGENT_MODEL);
    expect(report.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id));
    const known = report.cases.find((c) => c.id === "accounting-expenses-by-cost-center")!;
    // The mock builds the month from the current year; the case pins 2026, so the guard is on the tool and the grouping.
    expect(known.got?.tool).toBe("kernel__data__query");
    expect(known.got?.input).toMatchObject({ entity: "accounting.ledger_line", groupBy: ["cost_center_code"] });
    // It cannot answer the other prompts: they fail with a reason, they do not abort the run.
    expect(report.cases.filter((c) => !c.pass && c.id !== known.id).every((c) => c.why)).toBe(true);
    expect(report.corePass).toBe(report.cases.every((c) => c.pass));
    const usage = await h.sql<{ model: string; provider: string; task: string; user_id: string; cost_usd: string }[]>`
      select model, provider, task, user_id, cost_usd from kernel.llm_usage where company_id = ${h.companyId}`;
    expect(usage).toHaveLength(cases.length);
    expect(usage.every((u) => u.model === MOCK_AGENT_MODEL && u.provider === "mock" && u.task === "chat" && u.user_id === h.admin.claims.sub && Number(u.cost_usd) === 0)).toBe(true);
  });

  it("reads the model only from kernel.model_policies: with the chat policy deleted it fails with MissingModelPolicy", async () => {
    setAgentModelFactory(agentModelFactory({ AGENT_MODEL: "mock" }));
    const rollback = new Error("rollback");
    await expect(
      h.sql.begin(async (tx) => {
        await tx`delete from kernel.model_policies where task = 'chat'`;
        await expect(runEvals({ ...run(), sql: tx as unknown as typeof h.sql })).rejects.toBeInstanceOf(MissingModelPolicy);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("every data.query case's expected input returns rows on the demo ledger once its literal is swapped for a seeded one (FE-1234 → FE-1001)", async () => {
    const queries = cases.filter((c) => c.expect.process === "kernel.data.query");
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const c of queries) {
      // The seeded ledger has FE-1001, and entries dated in the fixture's year: swap the literals the cases pin.
      const input = JSON.parse(JSON.stringify(c.expect.input).replaceAll("FE-1234", "FE-1001").replaceAll("2026-10-01", `${year}-01-01`).replaceAll("2026-10-31", `${year}-01-31`));
      const result = (await runProcess(h.deps, { ...h.admin, origin: "agent" }, "kernel.data.query", input)) as { rows: unknown[] };
      expect(result.rows.length, c.id).toBeGreaterThan(0);
    }
  });
});
