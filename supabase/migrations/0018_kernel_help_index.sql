-- 0018_kernel_help_index
-- Forward-only migration (rule 34). Covered by packages/kernel/src/help/__tests__/help.integration.test.ts
-- The help knowledge index (design §7, rule 35): chunks of the user guides and one chunk per registered process, with
-- an embedding for `kernel.help.search` (cosine distance). `platform` chunks are the product's own and belong to no
-- company; `company` chunks (the hand-off summary of a company, a later task) belong to one. The index is rebuilt by a
-- build step with the service role (`pnpm help:index`), never by a user: authenticated users only read it.

create extension if not exists vector with schema extensions;

create table kernel.help_chunks (
  id         uuid primary key default kernel.uuid_v7(),
  scope      text not null check (scope in ('platform', 'company')),
  company_id uuid references kernel.companies (id) on delete cascade,
  -- `guide:<file>` for a user guide chunk, `process:<id>` for a registered process, `company:<topic>` for company text.
  source     text not null check (btrim(source) <> ''),
  -- Where the answer's deep link goes (`/parties?new=1`); null when the chunk has no screen.
  href       text,
  title      text not null,
  body       text not null,
  embedding  extensions.vector(1536) not null,
  locale     text not null default 'es-419',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A platform chunk belongs to no company; a company chunk to exactly one.
  check ((scope = 'platform' and company_id is null) or (scope = 'company' and company_id is not null))
);
create index help_chunks_scope_idx on kernel.help_chunks (scope, locale);
create index help_chunks_company_id_idx on kernel.help_chunks (company_id) where company_id is not null;
-- Approximate nearest neighbours by cosine distance. HNSW needs no training data (an ivfflat index built on a small
-- or empty table recalls badly) and keeps full recall at this size without tuning the search.
create index help_chunks_embedding_idx on kernel.help_chunks using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);

create trigger help_chunks_touch_updated before update on kernel.help_chunks
  for each row execute function kernel.touch_updated();

alter table kernel.help_chunks enable row level security;

-- Everyone signed in reads the platform chunks; a company's chunks only its members read. Writes: service role only.
create policy read_help on kernel.help_chunks for select to authenticated
  using (
    scope = 'platform'
    or (company_id is not null and array[company_id] <@ (select kernel.current_company_ids()))
  );

grant select on kernel.help_chunks to authenticated;
grant all on kernel.help_chunks to service_role;
