---
tags: [resource, ai]
date: 2026-11-07
status: active
---

# Assistant evals

Source: `docs/evals.md`.

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
