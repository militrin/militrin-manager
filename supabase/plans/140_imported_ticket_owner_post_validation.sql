-- 140_imported_ticket_owner_post_validation.sql
-- SELECT-only. Executar depois da 140 para validar a semantica final dos importados.

with ticket_context as (
  select t.id ticket_id,t.event_id,t.organization_id,t.owner_user_id,o.user_id order_user_id,
    o.buyer_type,o.import_batch_id order_import_batch_id,o.participant_id order_participant_id,
    coalesce(oi.participant_id,t.participant_id) holder_participant_id,
    coalesce(oi.registration_contact_id,hp.registration_contact_id) registration_contact_id,
    hp.full_name holder_name
  from public.tickets t
  join public.orders o on o.id=t.order_id
  left join public.order_items oi on oi.id=t.order_item_id
  left join public.participants hp on hp.id=coalesce(oi.participant_id,t.participant_id)
), evidence as (
  select c.*,e.import_batch_ids,e.imported_by_user_ids,
    (c.buyer_type='imported_holder' or cardinality(coalesce(e.import_batch_ids,array[]::uuid[]))>0) is_imported
  from ticket_context c
  left join lateral (
    select array_agg(distinct ib.id order by ib.id) import_batch_ids,
      array_agg(distinct ib.imported_by order by ib.imported_by) filter(where ib.imported_by is not null) imported_by_user_ids
    from public.import_batches ib
    where ib.id=c.order_import_batch_id or exists(
      select 1 from public.participation_history ph where ph.import_batch_id=ib.id and ph.source='import'
        and ph.participant_id in(c.order_participant_id,c.holder_participant_id))
  ) e on true
), resolved as (
  select e.*,coalesce(a.account_count,0) holder_account_count,
    case when coalesce(a.account_count,0)=1 then a.holder_account_user_id end holder_account_user_id
  from evidence e
  left join lateral (
    select count(distinct p.user_id)::integer account_count,
      (array_agg(distinct p.user_id order by p.user_id))[1] holder_account_user_id
    from public.participants p join auth.users au on au.id=p.user_id
    where p.organization_id=e.organization_id and p.registration_contact_id=e.registration_contact_id
      and not(p.user_id=any(coalesce(e.imported_by_user_ids,array[]::uuid[])))
  ) a on true where e.is_imported
)
select r.ticket_id,ev.name event_name,r.buyer_type,r.import_batch_ids,r.order_user_id,
  r.holder_participant_id,r.holder_name,r.registration_contact_id,r.holder_account_user_id,
  r.imported_by_user_ids,r.owner_user_id,
  case when r.holder_account_count>1 then 'AMBIGUO'
    when r.owner_user_id is distinct from r.holder_account_user_id then 'OWNER_INCORRETO'
    when r.owner_user_id=any(coalesce(r.imported_by_user_ids,array[]::uuid[])) then 'OWNER_E_OPERADOR'
    else 'OWNER_CORRETO' end classification
from resolved r left join public.events ev on ev.id=r.event_id
order by classification,event_name,ticket_id;

-- Resultado esperado: zero linhas.
with validation as (
  select t.id
  from public.tickets t join public.orders o on o.id=t.order_id
  where t.owner_user_id is not null and (
    (o.import_batch_id is not null and exists(select 1 from public.import_batches ib where ib.id=o.import_batch_id and ib.imported_by=t.owner_user_id))
    or exists(select 1 from public.participation_history ph join public.import_batches ib on ib.id=ph.import_batch_id
      where ph.source='import' and ib.imported_by=t.owner_user_id
        and ph.participant_id in(o.participant_id,t.participant_id)))
)
select * from validation;
