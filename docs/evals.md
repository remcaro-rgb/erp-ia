# Assistant evaluation set (rule 30, design §7.1)

A growing set of Spanish prompts, each with the tool call the assistant must make. It runs three ways.

| Where | What it checks | Model | Cost |
|---|---|---|---|
| `evals.test.ts` (every push, unit) | the set against the registry: the process exists and is offered, a write expects a confirmation card, the expected input names only fields, enum values and entities that exist | none | none |
| `evals-model.integration.test.ts` (every push, local stack) | the runner's plumbing: model from `kernel.model_policies`, tool set of the caller, recorder, usage rows, report | `mock/agent` | none |
| `pnpm evals` / `.github/workflows/evals.yml` (nightly, 01:17 Bogotá, and manual) | whether the policy's chat model makes the right call | the `chat` policy of `kernel.model_policies` | metered under Laura (`kernel.llm_usage`) |

The nightly job runs only when the repository has the secret `AI_GATEWAY_API_KEY`; without it the job ends green and says it skipped.

## Run it

```bash
pnpm db:reset && DEMO_SEED=1 pnpm db:seed   # the demo company: Laura is the caller
AI_GATEWAY_API_KEY=… pnpm evals             # against the policy model
AGENT_MODEL=mock pnpm evals --allow-fail    # plumbing only: the mock answers one prompt, the rest fail by design
```

Each prompt is sent for one model step with the system prompt of a real turn and Laura's tools. No tool executes: a recorder answers, so nothing is written to the company's data. Only the usage rows are written.

## Read the report

`eval-report.json` (and the table in the job log):

- `model`: the model that answered (`mock/agent` for the mock).
- `cases[]`: `id`, `tier`, `pass`, `got` (the tool and input the model called, or `null`), `why` (the first difference: a wrong tool, a missing field, a wrong value, text instead of a call, or the model error).
- `passRate`: passed cases over all cases.
- `corePass`: every `core` case passed.

The run passes when `corePass` is true and `passRate ≥ 0.9` (owner 2026-10-30). Otherwise `pnpm evals` exits 1 (unless `--allow-fail`).

How a call matches: the tool is the process id with `.` → `__`; the case's `input` must be contained in the model's input (every named field present with the same value; lists contain the listed elements, in any order; extra fields are fine).

## The sales chain (plan 2B Task 25)

`evals/sales-chain.json` holds the quote → receipt prompts («cotiza 10 café a Distribuidora X», «confirma el pedido 12», «factura lo entregado», «registra el pago de la factura FE-1234», the annulment and the step-up writes). The set checks the tool call only; what the call does is checked against the database in `sales-tools.integration.test.ts` (every push): each write's card lists the other modules' effects (`ModuleDef.effects` plus the posting provider's `effectsFor`), a customer that is not `invoice_ready` gets no card (the dry run's refusal and its reasons go back to the model), and a step-up process's card runs only with the code. `tool-exposure.test.ts` derives from the registry which processes are never tools (origins without `agent`, `nestedOnlyFrom`, `EXCLUDED_PROCESSES`).

The nightly run uses Laura's tools: the 2B cases pass only once the demo company has the 2B modules and Laura's role holds their processes (plan 2B Task 26).

## Add a case

Add an object to a file in `packages/agent/src/__tests__/evals/` (or a new `*.json` there):

```json
{
  "id": "accounting-aging-over-90",
  "prompt": "¿quién me debe más de 90 días?",
  "tier": "core",
  "expect": { "process": "accounting.report.aging", "input": { "params": { "kind": "receivable" } } }
}
```

- `tier`: `core` for what the product cannot get wrong; `extended` for the rest (they count toward the 90 %).
- `expect.process` is a registered process the assistant is offered; `confirmation: true` for a write.
- `expect.input` names only what matters. The unit suite rejects an unknown field or enum value.
- A `kernel.data.query` case must return rows on the demo ledger; the integration test runs it (swapping a literal the demo does not have, such as `FE-1234` → `FE-1001`).
