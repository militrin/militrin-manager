-- 143_administrative_ticket_controlled_tests.sql
-- Teste controlado e persistente autorizado da RPC canonica apos a migration 143.

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','e8f5777b-3ed1-409d-b3f1-71724be5a09e',true);
select set_config('request.jwt.claim.role','authenticated',true);

create temporary table administrative_issue_test_results(
  scenario text primary key,
  ticket_id uuid not null,
  expected_registration_contact_id uuid,
  expected_owner_user_id uuid
) on commit preserve rows;

insert into administrative_issue_test_results
select 'without_holder',ticket_id,null::uuid,null::uuid
from public.issue_manual_ticket_batch(
  'c90ed570-a2f3-4601-b076-bcc18714075f',
  '6c931940-03ad-48c2-836c-754924a00d00',
  'c4919870-425b-4963-852d-b218b26c9cec',
  '58fac033-01fd-449c-84da-02d48aba27ce',1,
  'female','Babylook','M','system_failure',
  'Teste controlado 143: emissao administrativa sem titular',false
);

insert into administrative_issue_test_results
select 'holder_without_account',ticket_id,
  '456a80f3-a67e-4651-900d-e94ca96a5dca'::uuid,null::uuid
from public.issue_manual_ticket_batch(
  '456a80f3-a67e-4651-900d-e94ca96a5dca',
  '6c931940-03ad-48c2-836c-754924a00d00',
  'c4919870-425b-4963-852d-b218b26c9cec',
  '58fac033-01fd-449c-84da-02d48aba27ce',1,
  'female','Babylook','M','system_failure',
  'Teste controlado 143: titular sem conta',true
);

insert into administrative_issue_test_results
select 'holder_with_account',ticket_id,
  '653bcb04-b712-492b-96c8-01cc3496ee33'::uuid,
  '84fc74b5-095a-466f-a4dc-c52e4f3f2681'::uuid
from public.issue_manual_ticket_batch(
  '653bcb04-b712-492b-96c8-01cc3496ee33',
  '6c931940-03ad-48c2-836c-754924a00d00',
  'c4919870-425b-4963-852d-b218b26c9cec',
  '58fac033-01fd-449c-84da-02d48aba27ce',1,
  'male','Camiseta','M','system_failure',
  'Teste controlado 143: titular com conta inequivoca',true
);

do $$
declare v_failure jsonb;
begin
  select jsonb_agg(to_jsonb(v)) into v_failure
  from (
    select r.scenario,r.ticket_id,t.status,t.owner_user_id,o.buyer_type,o.user_id as buyer_user_id,
      oi.participant_id,coalesce(oi.registration_contact_id,h.registration_contact_id) registration_contact_id,
      p.payment_method,p.payment_status,p.final_amount,a.details
    from administrative_issue_test_results r
    join public.tickets t on t.id=r.ticket_id
    join public.orders o on o.id=t.order_id
    join public.order_items oi on oi.id=t.order_item_id
    left join public.participants h on h.id=coalesce(oi.participant_id,t.participant_id)
    join public.payments p on p.order_id=o.id
    left join lateral (
      select al.details from public.audit_logs al
      where al.action='manual_ticket_issued' and al.entity_type='tickets' and al.entity_id=t.id
      order by al.created_at desc limit 1
    ) a on true
    where t.status<>'active'
      or t.owner_user_id is distinct from r.expected_owner_user_id
      or o.buyer_type<>'administrative' or o.user_id is not null
      or coalesce(oi.registration_contact_id,h.registration_contact_id) is distinct from r.expected_registration_contact_id
      or (r.expected_registration_contact_id is null and (oi.participant_id is not null or t.participant_id is not null))
      or (r.expected_registration_contact_id is not null and coalesce(oi.participant_id,t.participant_id) is null)
      or p.payment_method<>'courtesy' or p.payment_status<>'paid' or p.final_amount<>0
      or a.details->>'actor_user_id'<>'e8f5777b-3ed1-409d-b3f1-71724be5a09e'
      or a.details->>'issue_reason'<>'system_failure'
      or a.details->>'payment_method'<>'courtesy'
      or a.details->>'buyer_type'<>'administrative'
  ) v;
  if v_failure is not null then
    raise exception 'ADMINISTRATIVE_ISSUE_CONTROLLED_TEST_FAILED: %',v_failure;
  end if;
end; $$;

commit;

select r.scenario,r.ticket_id,t.status,t.owner_user_id,o.id order_id,o.buyer_type,
  o.user_id buyer_user_id,oi.id order_item_id,oi.participant_id,
  coalesce(oi.registration_contact_id,h.registration_contact_id) registration_contact_id,
  h.full_name holder_name,p.id payment_id,p.payment_method,p.payment_status,p.final_amount,
  a.details->>'actor_user_id' audit_actor_user_id,a.details->>'issue_reason' issue_reason,
  a.details->>'reason_text' reason_text
from administrative_issue_test_results r
join public.tickets t on t.id=r.ticket_id
join public.orders o on o.id=t.order_id
join public.order_items oi on oi.id=t.order_item_id
left join public.participants h on h.id=coalesce(oi.participant_id,t.participant_id)
join public.payments p on p.order_id=o.id
left join lateral (
  select al.details from public.audit_logs al
  where al.action='manual_ticket_issued' and al.entity_type='tickets' and al.entity_id=t.id
  order by al.created_at desc limit 1
) a on true
order by r.scenario;
