-- 0019_kernel_agent
-- Forward-only migration (rule 34). Covered by packages/agent/src/__tests__/schema.integration.test.ts (policies,
-- isolation of conversations, messages, confirmations and usage) and the agent's turn and tool suites.
-- The assistant's runtime tables (design §7.1, §7.4, rules 17, 26 and 27):
--   kernel.model_policies      which model serves each task (platform rows with tenant_id null, tenant overrides);
--   kernel.agent_conversations one row per chat thread of a user in a company;
--   kernel.agent_messages      the turns of a conversation (user text, the assistant's response messages, events);
--   kernel.agent_confirmations a write the assistant proposed and the user confirms or rejects (the card);
--   kernel.llm_usage           one row per model call (and per embedding call), with tokens and cost.
-- The agent workflow writes its own bookkeeping rows with the service role (rule 12: service role only inside
-- Workflows and route handlers); signed-in users only read them, each their own (company admins every row of their
-- company). The one exception is `llm_usage`: a process that calls a model as the user (kernel.help.search embeds the
-- question) records its own row in its transaction, as the caller.
-- Like the other kernel tables (imports, export jobs) these carry no `seq` / `extra`: those belong to module records,
-- and the kernel never depends on the core module's numbering.

-- ---------------------------------------------------------------------------------------------
-- Model policy (design §7.4, rule 26): no model id lives in code; the runtime reads this table per call.
-- ---------------------------------------------------------------------------------------------
create table kernel.model_policies (
  id             uuid primary key default kernel.uuid_v7(),
  -- Null: the platform default for the task. A tenant row overrides it for that tenant only.
  tenant_id      uuid references kernel.tenants (id) on delete cascade,
  task           text not null check (task in ('chat', 'planning', 'classification', 'summarization', 'extraction', 'embeddings', 'recommendations')),
  -- AI Gateway model ids: `<provider>/<model>`.
  primary_model  text not null check (primary_model ~ '^[a-z0-9-]+/[a-zA-Z0-9._-]+$'),
  -- Tried in order when the primary fails (provider error, rate limit). Every policy has at least one (rule 26).
  fallbacks      text[] not null check (cardinality(fallbacks) >= 1 and array_position(fallbacks, null) is null),
  max_cost_usd   numeric(18,4) check (max_cost_usd is null or max_cost_usd >= 0),
  data_residency text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique nulls not distinct (tenant_id, task)
);
create index model_policies_tenant_id_idx on kernel.model_policies (tenant_id) where tenant_id is not null;

create trigger model_policies_touch_updated before update on kernel.model_policies
  for each row execute function kernel.touch_updated();

alter table kernel.model_policies enable row level security;
-- Every signed-in user reads the platform rows and their tenant's; only the service role (platform admin) writes.
create policy read_policies on kernel.model_policies for select to authenticated
  using (tenant_id is null or tenant_id = (select kernel.current_tenant_id()));
grant select on kernel.model_policies to authenticated;
grant all on kernel.model_policies to service_role;
select kernel.enable_row_audit('kernel', 'model_policies');

-- The defaults of the design (§7.4, rule 26), as AI Gateway ids. Embeddings: the help index is built with the primary;
-- the fallback has the same 1536 dimensions but another vector space, so it is only usable after a rebuild with it.
insert into kernel.model_policies (tenant_id, task, primary_model, fallbacks) values
  (null, 'chat',           'anthropic/claude-opus-5.5',     array['anthropic/claude-sonnet-5.5']),
  (null, 'planning',       'anthropic/claude-opus-5.5',     array['anthropic/claude-sonnet-5.5']),
  (null, 'classification', 'anthropic/claude-haiku-5.5',    array['anthropic/claude-sonnet-5.5']),
  (null, 'summarization',  'anthropic/claude-haiku-5.5',    array['anthropic/claude-sonnet-5.5']),
  (null, 'embeddings',     'openai/text-embedding-3-small', array['openai/text-embedding-ada-002']);

-- ---------------------------------------------------------------------------------------------
-- Conversations and messages (design §7.1). A conversation is its user's: company RLS, then only that user or a
-- company admin reads it. Writes: the service role (the turn route and the agent workflow).
-- ---------------------------------------------------------------------------------------------
create table kernel.agent_conversations (
  id         uuid primary key default kernel.uuid_v7(),
  company_id uuid not null references kernel.companies (id) on delete cascade,
  user_id    uuid not null references kernel.users (id) on delete cascade,
  title      text not null default '' check (char_length(title) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid
);
create index agent_conversations_company_user_idx on kernel.agent_conversations (company_id, user_id, created_at desc);
create index agent_conversations_user_id_idx on kernel.agent_conversations (user_id);

create trigger agent_conversations_touch_updated before update on kernel.agent_conversations
  for each row execute function kernel.touch_updated();

grant select on kernel.agent_conversations to authenticated;
grant all on kernel.agent_conversations to service_role;
select kernel.enable_company_rls('kernel', 'agent_conversations');
create policy own_or_admin on kernel.agent_conversations as restrictive for all to authenticated
  using (user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin()))
  with check (user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin()));

create table kernel.agent_messages (
  id              uuid primary key default kernel.uuid_v7(),
  company_id      uuid not null references kernel.companies (id) on delete cascade,
  conversation_id uuid not null references kernel.agent_conversations (id) on delete cascade,
  -- `user`: what the user wrote ([{type: 'text', text}]). `assistant`: the turn's response model messages in order
  -- (assistant and tool messages, AI SDK `ModelMessage`s). `event`: something that happened outside a turn (a
  -- confirmation card decided), told to the model on the next turn.
  role            text not null check (role in ('user', 'assistant', 'event')),
  parts           jsonb not null default '[]'::jsonb check (jsonb_typeof(parts) = 'array'),
  -- The workflow run that wrote the row: a retried step writes it once.
  run_id          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid
);
create index agent_messages_conversation_idx on kernel.agent_messages (conversation_id, created_at);
create index agent_messages_company_id_idx on kernel.agent_messages (company_id);
create unique index agent_messages_run_role_idx on kernel.agent_messages (conversation_id, run_id, role) where run_id is not null;

create trigger agent_messages_touch_updated before update on kernel.agent_messages
  for each row execute function kernel.touch_updated();

grant select on kernel.agent_messages to authenticated;
grant all on kernel.agent_messages to service_role;
select kernel.enable_company_rls('kernel', 'agent_messages');
-- Visible exactly when its conversation is (that policy decides: its user or a company admin).
create policy of_visible_conversation on kernel.agent_messages as restrictive for all to authenticated
  using (exists (select 1 from kernel.agent_conversations c where c.id = conversation_id))
  with check (exists (select 1 from kernel.agent_conversations c where c.id = conversation_id));

-- ---------------------------------------------------------------------------------------------
-- Confirmations (design §6 "Agent", rule 17): a write-kind tool call never runs; it stores the proposal here and the
-- user confirms or rejects the card. The token is the idempotency key of the run, and a decision holds a lock on the
-- card's row while the process runs, so a card confirmed twice runs once. `executed` holds the process result;
-- `confirmed` (a card accepted but not run yet) is reserved for decisions that run later (phase 1 runs at once).
-- ---------------------------------------------------------------------------------------------
create table kernel.agent_confirmations (
  id              uuid primary key default kernel.uuid_v7(),
  company_id      uuid not null references kernel.companies (id) on delete cascade,
  conversation_id uuid not null references kernel.agent_conversations (id) on delete cascade,
  -- The conversation's user: the only one who may decide the card.
  user_id         uuid not null references kernel.users (id) on delete cascade,
  process_id      text not null,
  input           jsonb not null,
  -- What the card shows: title, effects (label/value), permission and whether a step-up code is needed.
  preview         jsonb not null default '{}'::jsonb,
  token           text not null unique check (char_length(token) >= 32),
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'executed')),
  result          jsonb,
  expires_at      timestamptz not null default now() + interval '15 minutes',
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid
);
create index agent_confirmations_conversation_idx on kernel.agent_confirmations (conversation_id, created_at);
create index agent_confirmations_company_id_idx on kernel.agent_confirmations (company_id);
create index agent_confirmations_user_id_idx on kernel.agent_confirmations (user_id);

create trigger agent_confirmations_touch_updated before update on kernel.agent_confirmations
  for each row execute function kernel.touch_updated();

grant select on kernel.agent_confirmations to authenticated;
grant all on kernel.agent_confirmations to service_role;
select kernel.enable_company_rls('kernel', 'agent_confirmations');
select kernel.enable_row_audit('kernel', 'agent_confirmations');
create policy own_or_admin on kernel.agent_confirmations as restrictive for all to authenticated
  using (user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin()))
  with check (user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin()));

-- ---------------------------------------------------------------------------------------------
-- Usage (rule 27, design §7.4): one row per model or embedding call, priced at write time. `company` rows count
-- towards the company's monthly token limit (`limit:ai_tokens_month`); `platform` rows (building the help index)
-- belong to no company.
-- ---------------------------------------------------------------------------------------------
create table kernel.llm_usage (
  id              uuid primary key default kernel.uuid_v7(),
  scope           text not null default 'company' check (scope in ('company', 'platform')),
  company_id      uuid references kernel.companies (id) on delete cascade,
  user_id         uuid references kernel.users (id) on delete set null,
  conversation_id uuid references kernel.agent_conversations (id) on delete set null,
  task            text not null check (task in ('chat', 'planning', 'classification', 'summarization', 'extraction', 'embeddings', 'recommendations')),
  provider        text not null,
  model           text not null,
  input_tokens    integer not null default 0 check (input_tokens >= 0),
  output_tokens   integer not null default 0 check (output_tokens >= 0),
  -- Input tokens read from the provider's prompt cache (a part of input_tokens).
  cached_tokens   integer not null default 0 check (cached_tokens >= 0),
  cost_usd        numeric(18,6) not null default 0 check (cost_usd >= 0),
  -- The workflow run and model step that made the call: a retried step records it once.
  run_id          text,
  step_number     integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  check ((scope = 'company' and company_id is not null) or (scope = 'platform' and company_id is null))
);
create index llm_usage_company_created_idx on kernel.llm_usage (company_id, created_at);
create index llm_usage_user_id_idx on kernel.llm_usage (user_id);
create index llm_usage_conversation_id_idx on kernel.llm_usage (conversation_id) where conversation_id is not null;
create unique index llm_usage_run_step_idx on kernel.llm_usage (run_id, step_number, task) where run_id is not null;

grant select, insert on kernel.llm_usage to authenticated;
grant all on kernel.llm_usage to service_role;
select kernel.enable_company_rls('kernel', 'llm_usage');
-- A user reads their own rows; a company admin every row of the company.
create policy own_or_admin on kernel.llm_usage as restrictive for select to authenticated
  using (user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin()));
-- A user records a call only inside a process run (a process that calls a model as them), for themselves, in the
-- active company. Everything else is written by the service role.
create policy via_process_insert on kernel.llm_usage as restrictive for insert to authenticated
  with check (
    coalesce(current_setting('erp.audit_process_id', true), '') <> ''
    and scope = 'company'
    and user_id = (select kernel.current_user_id())
    and run_id is null
  );

-- ---------------------------------------------------------------------------------------------
-- Read views (rule 14): what the assistant drawer and the usage report read as the user. Same predicates as the
-- policies, so the views never depend on the base tables' policies alone. The confirmation token is not published.
-- ---------------------------------------------------------------------------------------------
create or replace view kernel.v_agent_conversations with (security_invoker = true) as
select id, company_id, user_id, title, created_at, updated_at
from kernel.agent_conversations
where user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin());
grant select on kernel.v_agent_conversations to authenticated;

create or replace view kernel.v_agent_messages with (security_invoker = true) as
select m.id, m.company_id, m.conversation_id, m.role, m.parts, m.created_at
from kernel.agent_messages m
where exists (select 1 from kernel.agent_conversations c where c.id = m.conversation_id
              and (c.user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin())));
grant select on kernel.v_agent_messages to authenticated;

create or replace view kernel.v_agent_confirmations with (security_invoker = true) as
select id, company_id, conversation_id, user_id, process_id, input, preview, status, result, expires_at, decided_at, created_at
from kernel.agent_confirmations
where user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin());
grant select on kernel.v_agent_confirmations to authenticated;

create or replace view kernel.v_llm_usage with (security_invoker = true) as
select id, company_id, user_id, conversation_id, task, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, created_at
from kernel.llm_usage
where user_id = (select kernel.current_user_id()) or (select kernel.is_company_admin());
grant select on kernel.v_llm_usage to authenticated;

create or replace view kernel.v_model_policies with (security_invoker = true) as
select id, tenant_id, task, primary_model, fallbacks, max_cost_usd, data_residency, updated_at
from kernel.model_policies
where tenant_id is null or tenant_id = (select kernel.current_tenant_id());
grant select on kernel.v_model_policies to authenticated;
