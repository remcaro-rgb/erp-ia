-- Invoice readiness for other modules (rule 10, design §5.17). core.v_parties masks invoice_ready by the caller's field
-- visibility, so a consumer that must enforce readiness (accounting's entry lines) reads this view instead: the id, the
-- company and the flag, under the same party scope as v_parties. Reads only; the flag stays computed by core's triggers.

create or replace view core.v_party_readiness with (security_invoker = true) as
select
  "id",
  "company_id",
  "invoice_ready"
from core.parties
where core.party_scope_allows((select kernel.party_scope()), kind);

grant select on core.v_party_readiness to authenticated;
