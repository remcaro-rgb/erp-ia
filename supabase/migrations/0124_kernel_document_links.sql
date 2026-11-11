-- 0124_kernel_document_links
-- Forward-only migration (rule 34). Covered by packages/kernel/src/links/__tests__/document-links.integration.test.ts and
-- packages/kernel/src/__tests__/definer-guards.integration.test.ts.
-- The document link table and trail (owner 2026-11-06, design §22.27, plan 2B Task 31). A business flow across user actions is followed
-- through links between documents, not through a copied id; the causal chain id stays one per user action and each link stores the chain
-- of the action that created it.
--   * kernel.document_links: one row per link between two documents (entity and id on each side, a kind `<a>_to_<b>` the writing module
--     declares, the chain). Many to many. The kernel treats the entities as opaque strings (rule 4): no module is named here.
--   * Users read no raw row; the trail reads the links through kernel.document_link_step inside its own run.
--   * Written only inside the run of the process that names itself (rule 1), a registered create or update of the module that owns the
--     `to` document (kernel.entity_tables), through kernel.document_link_sync (the set of one kind into one document; a Borrador's extra
--     links are removed, never a marked one) and kernel.document_link_mark_voided (a void keeps the row, marked).
--   * kernel.document_trail walks the links up and down from a record as the caller (security invoker): depth ≤ 12, at most 500 documents,
--     cycle-safe, deterministic. A document the caller may not see (no consult process of its entity, or its read view does not show the
--     row under their RLS) is walked through but never named: its entity, id and the kind of every edge touching it come back null; the
--     caller only learns how many there are.
--   * The baseline grant of every role gains `kernel.document_link.%` (the consult kernel.document_link.trail), as kernel.recommendation.%.

create table kernel.document_links (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  from_entity     text not null check (from_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  from_id         uuid not null,
  to_entity       text not null check (to_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  to_id           uuid not null,
  kind            text not null check (kind ~ '^[a-z]+_to_[a-z]+$'),
  origin          text not null default 'process' check (origin in ('process', 'backfill')),
  chain_id        uuid,
  voided_at       timestamptz,
  voided_chain_id uuid,
  void_reason     text check (void_reason is null or length(void_reason) <= 500),
  -- Which end(s) of the link were voided, as 'entity:id' (a link marked from both ends lists both): the trail flags a node only when it is
  -- one of them, so a live document next to a voided one is never shown as voided. voided_at/voided_chain_id/void_reason are the first mark's.
  voided_ends     text[] not null default '{}',
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  constraint document_links_not_self check ((from_entity, from_id) is distinct from (to_entity, to_id)),
  -- Only a backfilled row may lack the chain (the original action's chain is not recoverable from the payload ids).
  constraint document_links_chain_ck check (origin = 'backfill' or chain_id is not null),
  constraint document_links_void_ck check ((voided_at is null) = (voided_chain_id is null) or origin = 'backfill'),
  constraint document_links_ends_ck check ((voided_at is null) = (cardinality(voided_ends) = 0))
);
create unique index document_links_key_uq on kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind);
create index document_links_from_idx on kernel.document_links (company_id, from_entity, from_id);
create index document_links_to_idx on kernel.document_links (company_id, to_entity, to_id);
create trigger assign_seq before insert on kernel.document_links for each row execute function core.assign_seq('kernel.document_link');
create trigger document_links_touch_updated before update on kernel.document_links for each row execute function kernel.touch_updated();
-- Users read no raw row (review of stage A, concern 1): the ids, kinds, reasons and authors of documents they may not see stay out of
-- reach; the trail walks the links through kernel.document_link_step, inside its own run only. Writes go through the definer writers.
revoke all on kernel.document_links from authenticated;
grant all on kernel.document_links to service_role;
select kernel.enable_company_rls('kernel', 'document_links');
select kernel.enable_row_audit('kernel', 'document_links');

-- ---------------------------------------------------------------------------------------------
-- The process gate of both writers (as 0123's kernel.recommendation_writer): a user session reaches them only inside the run of the
-- process it names (rule 1), that process is a registered create or update, the company is the caller's active one, and the module of
-- that process owns the entity (kernel.entity_tables.module_id). Answers the module.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.document_link_writer(p_process text, p_entity text, p_unlink boolean default false) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_module text;
  v_owner text;
  v_company uuid := kernel.current_company_id();
begin
  if p_process is null or coalesce(current_setting('erp.audit_process_id', true), '') <> p_process then
    raise exception 'a document link is written only inside a process run of %', coalesce(p_process, '(none)') using errcode = 'insufficient_privilege';
  end if;
  select rp.module_id into v_module from kernel.registered_processes rp where rp.process_id = p_process and (rp.kind in ('create', 'update') or (p_unlink and rp.kind = 'delete'));
  if v_module is null then
    raise exception 'process % may not write document links: it is not a registered create or update process (a delete process may only unlink: sync with from [])', p_process using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'a document link is written for the caller''s active company' using errcode = 'insufficient_privilege';
  end if;
  select et.module_id into v_owner from kernel.entity_tables et where et.entity = p_entity;
  if v_owner is null then
    raise exception 'document link: % is not a registered maestro or documento', coalesce(p_entity, '(none)') using errcode = 'invalid_parameter_value';
  end if;
  if v_owner <> v_module then
    raise exception 'process % may not write the document links of %: module % owns it', p_process, p_entity, v_owner using errcode = 'insufficient_privilege';
  end if;
  return v_module;
end;
$$;
revoke execute on function kernel.document_link_writer(text, text, boolean) from public, anon, authenticated;
grant execute on function kernel.document_link_writer(text, text, boolean) to service_role;

-- Whether record p_id of entity p_entity exists in company p_company (definer: the table of the entity, never named by the caller),
-- and its status when it is a documento. Not granted to users: the writers below call it.
create or replace function kernel.document_link_record(p_entity text, p_id uuid, p_company uuid, out present boolean, out entity_type text, out status text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_schema text;
  v_table text;
begin
  present := false;
  select et.table_schema, et.table_name, et.entity_type into v_schema, v_table, entity_type from kernel.entity_tables et where et.entity = p_entity;
  if v_schema is null then
    raise exception 'document link: % is not a registered maestro or documento', coalesce(p_entity, '(none)') using errcode = 'invalid_parameter_value';
  end if;
  if v_schema !~ '^[a-z_][a-z0-9_]*$' or v_table !~ '^[a-z_][a-z0-9_]*$' then
    raise exception 'document link: invalid identifier for %', p_entity using errcode = 'invalid_parameter_value';
  end if;
  if p_id is null or p_company is null then
    return;
  end if;
  execute format('select t.status from %I.%I t where t.id = $1 and t.company_id = $2', v_schema, v_table) into status using p_id, p_company;
  -- EXECUTE … INTO does not set FOUND; status is not null on every typed table (kernel.typed_columns).
  present := status is not null;
end;
$$;
revoke execute on function kernel.document_link_record(text, uuid, uuid) from public, anon, authenticated;
grant execute on function kernel.document_link_record(text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Makes the set of `p_kind` links into document (p_to_entity, p_to_id) equal to p_from ([{entity, id}]): inserts the missing links
-- (selected first, so a retried call burns no seq), removes the extra only while the `to` document is a Borrador (a documento in
-- status 'draft': the only status the lifecycle deletes, D1, §22.23) and never a marked (voided) one, except when a delete process unlinks the Borrador it is deleting. Every end must exist in the caller's
-- company. Concurrent syncs of one document and kind queue on an advisory lock.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.document_link_sync(p_process text, p_to_entity text, p_to_id uuid, p_kind text, p_from jsonb)
returns table (inserted integer, removed integer)
language plpgsql volatile security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  -- A delete process (Eliminar of a Borrador) may only unlink: sync with from [] on its own document; it never inserts or marks.
  v_module text := kernel.document_link_writer(p_process, p_to_entity, p_from is not null and p_from = '[]'::jsonb);
  v_company uuid := kernel.current_company_id();
  v_chain uuid := nullif(current_setting('erp.audit_chain_id', true), '')::uuid;
  v_to record;
  v_end record;
  v_from record;
  v_inserted integer := 0;
  v_removed integer := 0;
  -- A delete process unlinks a Borrador about to be deleted: its marked rows go too (a link never outlives its document, R31-2; the row audit keeps the history).
  v_deleting boolean := exists (select 1 from kernel.registered_processes rp where rp.process_id = p_process and rp.kind = 'delete');
begin
  if p_kind is null or p_kind !~ '^[a-z]+_to_[a-z]+$' then
    raise exception 'document link kind % is not <a>_to_<b>', coalesce(p_kind, '(none)') using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or jsonb_typeof(p_from) <> 'array' or jsonb_array_length(p_from) > 200 then
    raise exception 'document link: from must be an array of at most 200 documents' using errcode = 'invalid_parameter_value';
  end if;
  if v_chain is null then
    raise exception 'a document link is written inside a process run with its chain' using errcode = 'insufficient_privilege';
  end if;
  select * into v_to from kernel.document_link_record(p_to_entity, p_to_id, v_company);
  if not v_to.present then
    raise exception 'erp:invalid_input:El documento que se vincula no existe en la empresa';
  end if;
  for v_end in select e ->> 'entity' as entity, e ->> 'id' as id from jsonb_array_elements(p_from) e loop
    if v_end.entity is null or v_end.id is null or v_end.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'document link: every from is {entity, id}' using errcode = 'invalid_parameter_value';
    end if;
    if (v_end.entity, v_end.id::uuid) = (p_to_entity, p_to_id) then
      raise exception 'document link: a document is not linked to itself' using errcode = 'invalid_parameter_value';
    end if;
    select * into v_from from kernel.document_link_record(v_end.entity, v_end.id::uuid, v_company);
    if not v_from.present then
      raise exception 'erp:invalid_input:Un documento de origen del vínculo no existe en la empresa';
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('kernel.document_link:' || v_company || ':' || p_to_entity || ':' || p_to_id || ':' || p_kind, 0));

  -- Removal first, so a Borrador re-pointed to other documents keeps its seq order; only a Borrador's, never a marked row.
  if v_to.entity_type = 'documento' and v_to.status = 'draft' then
    delete from kernel.document_links l
    where l.company_id = v_company and l.to_entity = p_to_entity and l.to_id = p_to_id and l.kind = p_kind and (l.voided_at is null or v_deleting)
      and not exists (select 1 from jsonb_array_elements(p_from) e where e ->> 'entity' = l.from_entity and (e ->> 'id')::uuid = l.from_id);
    get diagnostics v_removed = row_count;
  end if;

  insert into kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind, origin, chain_id)
  select v_company, m.entity, m.id, p_to_entity, p_to_id, p_kind, 'process', v_chain
  from (
    select distinct e ->> 'entity' as entity, (e ->> 'id')::uuid as id, min(e.o) over (partition by e ->> 'entity', e ->> 'id') as o
    from jsonb_array_elements(p_from) with ordinality as e(e, o)
  ) m
  where not exists (
    select 1 from kernel.document_links l
    where l.company_id = v_company and l.from_entity = m.entity and l.from_id = m.id and l.to_entity = p_to_entity and l.to_id = p_to_id and l.kind = p_kind)
  order by m.o
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  return query select v_inserted, v_removed;
end;
$$;
revoke execute on function kernel.document_link_sync(text, text, uuid, text, jsonb) from public, anon;
grant execute on function kernel.document_link_sync(text, text, uuid, text, jsonb) to authenticated, service_role;

-- Marks every link touching document (p_entity, p_id) as voided by this action (kept, never deleted) and records that THIS document is the voided
-- end; a link already marked from its other end keeps its first mark (time, chain, reason) and gains this end; a document is not marked twice.
create or replace function kernel.document_link_mark_voided(p_process text, p_entity text, p_id uuid, p_reason text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_module text := kernel.document_link_writer(p_process, p_entity);
  v_company uuid := kernel.current_company_id();
  v_chain uuid := nullif(current_setting('erp.audit_chain_id', true), '')::uuid;
  v_count integer;
begin
  if v_chain is null then
    raise exception 'a document link is marked inside a process run with its chain' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is not null and length(p_reason) > 500 then
    raise exception 'document link: the void reason is at most 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  update kernel.document_links l
  set voided_at = coalesce(l.voided_at, now()), voided_chain_id = coalesce(l.voided_chain_id, v_chain), void_reason = coalesce(l.void_reason, p_reason),
      voided_ends = array_append(l.voided_ends, p_entity || ':' || p_id), updated_by = kernel.current_user_id()
  where l.company_id = v_company and not ((p_entity || ':' || p_id) = any (l.voided_ends))
    and ((l.from_entity = p_entity and l.from_id = p_id) or (l.to_entity = p_entity and l.to_id = p_id));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function kernel.document_link_mark_voided(text, text, uuid, text) from public, anon;
grant execute on function kernel.document_link_mark_voided(text, text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The consult processes of an entity: the ones packages/kernel/src/query/access.ts consultProcessesOf names for a maestro or documento
-- (`<entity>.consult`, or `<module>.<last word of the name>.consult`), registered as consults of the entity's module. The integration
-- test compares the two over every row of kernel.entity_tables.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.entity_consult_processes(p_entity text) returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(rp.process_id order by rp.process_id), '{}')
  from kernel.entity_tables et
  join kernel.registered_processes rp
    on rp.kind = 'consult' and rp.module_id = et.module_id
   and rp.process_id in (et.entity || '.consult',
                         et.module_id || '.' || regexp_replace(substr(et.entity, strpos(et.entity, '.') + 1), '^.*_', '') || '.consult')
  where et.entity = p_entity;
$$;
revoke execute on function kernel.entity_consult_processes(text) from public, anon;
grant execute on function kernel.entity_consult_processes(text) to authenticated, service_role;

-- Whether the caller's active company is entitled to the module of an entity (the kernel is the platform: always). Module level only, as
-- the SQL has no feature-to-entity catalogue (ruling of the stage A review, I-2); the grid's requireGridAccess also asks the feature.
-- Definer because kernel.entitled is not granted to users; it answers only for the caller's own active company.
create or replace function kernel.entity_entitled(p_entity text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_module text;
  v_company uuid := kernel.current_company_id();
begin
  select et.module_id into v_module from kernel.entity_tables et where et.entity = p_entity;
  if v_module is null or v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    return false;
  end if;
  return v_module = 'kernel' or kernel.entitled(v_company, 'module:' || v_module);
end;
$$;
revoke execute on function kernel.entity_entitled(text) from public, anon;
grant execute on function kernel.entity_entitled(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Whether the caller sees record p_id of entity p_entity: the company is entitled to its module, a role of theirs may run one of the
-- entity's consult processes, and the entity's read view (<schema>.v_<table>, the masked view kernel.data.query and the clone source
-- check read) shows the row under their RLS (company, party scope, record rules). As the caller.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.document_visible(p_entity text, p_id uuid) returns boolean
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_schema text;
  v_table text;
  v_seen boolean;
begin
  if p_entity is null or p_id is null then
    return false;
  end if;
  select et.table_schema, et.table_name into v_schema, v_table from kernel.entity_tables et where et.entity = p_entity;
  if v_schema is null or v_schema !~ '^[a-z_][a-z0-9_]*$' or v_table !~ '^[a-z_][a-z0-9_]*$' then
    return false;
  end if;
  if not kernel.entity_entitled(p_entity)
     or not exists (select 1 from unnest(kernel.entity_consult_processes(p_entity)) p where kernel.can_run_process(p)) then
    return false;
  end if;
  if to_regclass(format('%I.%I', v_schema, 'v_' || v_table)) is null then
    return false;
  end if;
  execute format('select exists (select 1 from %I.%I v where v.id = $1)', v_schema, 'v_' || v_table) into v_seen using p_id;
  return coalesce(v_seen, false);
end;
$$;
revoke execute on function kernel.document_visible(text, uuid) from public, anon;
grant execute on function kernel.document_visible(text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- One level of the walk: the links of the caller's active company that leave (down) or reach (up) the documents of the frontier, with the
-- document at their other end. Definer, because users read no raw row; it answers only inside a run of kernel.document_link.trail, which
-- masks what it returns (the visibility is asked as the caller, in kernel.document_trail).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.document_link_step(p_dir text, p_front_e text[], p_front_i uuid[])
returns table (parent_entity text, parent_id uuid, entity text, id uuid, kind text, voided boolean, created_at timestamptz, link_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := kernel.current_company_id();
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') <> 'kernel.document_link.trail' then
    raise exception 'document links are read only inside a process run of kernel.document_link.trail' using errcode = 'insufficient_privilege';
  end if;
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'document links are read for the caller''s active company' using errcode = 'insufficient_privilege';
  end if;
  if p_dir is null or p_dir not in ('up', 'down') then
    raise exception 'document_link_step: direction is up or down' using errcode = 'invalid_parameter_value';
  end if;
  return query
    select f.e, f.i,
           case when p_dir = 'up' then l.from_entity else l.to_entity end,
           case when p_dir = 'up' then l.from_id else l.to_id end,
           l.kind,
           -- voided: the document at the reached end is one the link was marked for (not the document it was reached from)
           (case when p_dir = 'up' then l.from_entity || ':' || l.from_id else l.to_entity || ':' || l.to_id end) = any (l.voided_ends),
           l.created_at, l.id
    from unnest(p_front_e, p_front_i) as f(e, i)
    join kernel.document_links l
      on l.company_id = v_company
     and ((p_dir = 'up' and l.to_entity = f.e and l.to_id = f.i) or (p_dir = 'down' and l.from_entity = f.e and l.from_id = f.i));
end;
$$;
revoke execute on function kernel.document_link_step(text, text[], uuid[]) from public, anon;
grant execute on function kernel.document_link_step(text, text[], uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The trail of a record the caller sees (nothing otherwise): breadth-first up (to the documents it comes from) and down (to the ones made
-- from it), upstream first, `p_depth` levels (1..12) and at most `p_cap` documents (1..500) in all; a document is returned once, at its
-- nearest level (a cycle ends there). Order: direction, depth, then the creation of the link that reached it and the document id.
-- A document the caller does not see is walked through and returned as a row with visible = false and no entity, id or kind; a visible
-- document reached from a hidden one has no kind and no voided flag either (they would name the hidden side, or tell that it was
-- voided). `voided`: the document itself was voided (the link names it among its voided ends), never because its neighbour was. `truncated` (on every row): the cap or the depth left documents out. The links
-- are read through kernel.document_link_step, so the function answers only inside a run of kernel.document_link.trail.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.document_trail(p_entity text, p_id uuid, p_direction text default 'both', p_depth integer default 6, p_cap integer default 100)
returns table (depth integer, direction text, kind text, entity text, id uuid, voided boolean, visible boolean, truncated boolean)
language plpgsql stable security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company uuid := kernel.current_company_id();
  v_dirs text[];
  v_dir text;
  v_level integer;
  v_seen text[];
  v_front_e text[];
  v_front_i uuid[];
  v_front_v boolean[];
  v_next record;
  v_count integer := 0;
  v_truncated boolean := false;
  r_depth integer[] := '{}';
  r_dir text[] := '{}';
  r_kind text[] := '{}';
  r_entity text[] := '{}';
  r_id uuid[] := '{}';
  r_voided boolean[] := '{}';
  r_visible boolean[] := '{}';
  v_new_e text[];
  v_new_i uuid[];
  v_new_v boolean[];
begin
  if p_direction is null or p_direction not in ('up', 'down', 'both') then
    raise exception 'document_trail: direction is up, down or both' using errcode = 'invalid_parameter_value';
  end if;
  if p_depth is null or p_depth < 1 or p_depth > 12 then
    raise exception 'document_trail: depth is 1 to 12' using errcode = 'invalid_parameter_value';
  end if;
  if p_cap is null or p_cap < 1 or p_cap > 500 then
    raise exception 'document_trail: cap is 1 to 500' using errcode = 'invalid_parameter_value';
  end if;
  if v_company is null or not kernel.document_visible(p_entity, p_id) then
    return;
  end if;
  v_dirs := case p_direction when 'both' then array['up', 'down'] else array[p_direction] end;
  v_seen := array[p_entity || '/' || p_id];

  <<directions>>
  foreach v_dir in array v_dirs loop
    v_front_e := array[p_entity];
    v_front_i := array[p_id];
    v_front_v := array[true];
    v_level := 0;
    while cardinality(v_front_e) > 0 loop
      v_level := v_level + 1;
      v_new_e := '{}';
      v_new_i := '{}';
      v_new_v := '{}';
      for v_next in
        select n.entity, n.id, n.kind, n.voided, n.parent_visible
        from (
          select distinct on (c.entity, c.id) c.entity, c.id, c.kind, c.voided, c.parent_visible, c.created_at, c.link_id
          from (
            select st.entity, st.id, st.kind, st.voided, f.v as parent_visible, st.created_at, st.link_id
            from kernel.document_link_step(v_dir, v_front_e, v_front_i) st
            join unnest(v_front_e, v_front_i, v_front_v) as f(e, i, v) on f.e = st.parent_entity and f.i = st.parent_id
          ) c
          where not ((c.entity || '/' || c.id) = any (v_seen))
          -- A document reached at one level from a visible and from a hidden parent keeps the visible edge (its kind can be named).
          order by c.entity, c.id, c.parent_visible desc, c.created_at, c.link_id
        ) n
        order by n.created_at, n.link_id, n.id
      loop
        if v_level > p_depth or v_count >= p_cap then
          -- A document beyond the depth or the cap exists: the trail is cut.
          v_truncated := true;
          exit directions when v_count >= p_cap;
          exit;
        end if;
        v_count := v_count + 1;
        v_seen := array_append(v_seen, v_next.entity || '/' || v_next.id);
        declare
          v_visible boolean := kernel.document_visible(v_next.entity, v_next.id);
        begin
          r_depth := array_append(r_depth, v_level);
          r_dir := array_append(r_dir, v_dir);
          r_kind := array_append(r_kind, case when v_visible and v_next.parent_visible then v_next.kind end);
          r_entity := array_append(r_entity, case when v_visible then v_next.entity end);
          r_id := array_append(r_id, case when v_visible then v_next.id end);
          r_voided := array_append(r_voided, case when v_visible and v_next.parent_visible then v_next.voided end);
          r_visible := array_append(r_visible, v_visible);
          v_new_e := array_append(v_new_e, v_next.entity);
          v_new_i := array_append(v_new_i, v_next.id);
          v_new_v := array_append(v_new_v, v_visible);
        end;
      end loop;
      exit when v_level > p_depth;
      v_front_e := v_new_e;
      v_front_i := v_new_i;
      v_front_v := v_new_v;
    end loop;
  end loop;

  return query
    select r.d, r.dir, r.k, r.e, r.i, r.vo, r.vi, v_truncated
    from unnest(r_depth, r_dir, r_kind, r_entity, r_id, r_voided, r_visible) with ordinality as r(d, dir, k, e, i, vo, vi, o)
    order by r.o;
end;
$$;
revoke execute on function kernel.document_trail(text, uuid, text, integer, integer) from public, anon;
grant execute on function kernel.document_trail(text, uuid, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The baseline every role gets (kernel.seed_role_defaults, as 0048) gains `kernel.document_link.%`, and every existing role gets the trail now (the process is registered at the next manifest sync; the permission row names it as 0048 did).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.seed_role_defaults(p_company uuid, p_role uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform kernel.assert_admin_write(p_company);
  select r.is_system and r.name = 'admin' into v_admin from kernel.roles r where r.id = p_role and r.company_id = p_company;
  if v_admin is null then
    raise exception 'role % is not a role of company %', p_role, p_company using errcode = '22023';
  end if;

  if v_admin then
    insert into kernel.process_permissions (company_id, role_id, process_id)
    select p_company, p_role, rp.process_id from kernel.registered_processes rp
    on conflict (company_id, role_id, process_id) do nothing;
    return;
  end if;

  insert into kernel.process_permissions (company_id, role_id, process_id)
  select p_company, p_role, rp.process_id
  from kernel.registered_processes rp
  where rp.process_id in ('kernel.help.search', 'kernel.data.query', 'kernel.attachment.list', 'kernel.verify.status', 'kernel.export.run', 'kernel.doc_template.print')
     or rp.process_id like 'kernel.saved\_view.%'
     or rp.process_id like 'kernel.user\_prefs.%'
     or rp.process_id like 'kernel.home.%'
     or rp.process_id like 'kernel.recommendation.%'
     or rp.process_id like 'kernel.document\_link.%'
     or (rp.kind = 'consult' and rp.module_id <> 'kernel' and kernel.entitled(p_company, 'module:' || rp.module_id))
  on conflict (company_id, role_id, process_id) do nothing;

  insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
  select p_company, p_role, ef.entity, ef.field, 'masked'
  from kernel.entity_fields ef
  where ef.sensitivity = 'confidential'
  on conflict (company_id, role_id, entity, field) do nothing;
end;
$$;
revoke execute on function kernel.seed_role_defaults(uuid, uuid) from public, anon;
grant execute on function kernel.seed_role_defaults(uuid, uuid) to authenticated, service_role;

insert into kernel.process_permissions (company_id, role_id, process_id)
select r.company_id, r.id, 'kernel.document_link.trail'
from kernel.roles r
where not (r.is_system and r.name = 'admin')
on conflict (company_id, role_id, process_id) do nothing;
