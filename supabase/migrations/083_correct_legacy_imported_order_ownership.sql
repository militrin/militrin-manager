-- 083_correct_legacy_imported_order_ownership.sql
-- Remove o operador da propriedade de pedidos comprovadamente originados por importacao.

begin;

create temporary table legacy_imported_orders_to_correct on commit drop as
select distinct on (o.id)
  o.id as order_id,
  o.event_id,
  o.participant_id,
  o.user_id as previous_user_id,
  ph.import_batch_id,
  ib.imported_by as imported_by_user_id,
  lower(au.email) as imported_by_email,
  concat(
    'participation_history.source=import; import_batch_id=', ph.import_batch_id,
    '; import_type=current_event_registrations',
    '; order.event_id=import_batch.event_id',
    '; order.user_id=import_batch.imported_by',
    '; order.created_at dentro da janela do lote'
  )::text as correction_reason
from public.orders o
join public.participation_history ph
  on ph.participant_id = o.participant_id
 and ph.source = 'import'
 and ph.import_batch_id is not null
join public.import_batches ib
  on ib.id = ph.import_batch_id
 and ib.import_type = 'current_event_registrations'
 and ib.event_id = o.event_id
 and ib.imported_by = o.user_id
left join auth.users au
  on au.id = ib.imported_by
where o.buyer_type = 'account'
  and o.import_batch_id is null
  and o.created_at >= ib.created_at
  and o.created_at <= coalesce(ib.completed_at, now())
order by o.id, ph.created_at desc;

select
  order_id,
  event_id,
  participant_id,
  import_batch_id,
  previous_user_id,
  imported_by_user_id,
  imported_by_email,
  correction_reason
from legacy_imported_orders_to_correct
order by order_id;

update public.orders o
set user_id = null,
    buyer_type = 'imported_holder',
    import_batch_id = c.import_batch_id
from legacy_imported_orders_to_correct c
where o.id = c.order_id;

update public.participants p
set user_id = null,
    updated_at = now()
from legacy_imported_orders_to_correct c
left join public.customer_profiles cp
  on cp.user_id = c.imported_by_user_id
left join auth.users au
  on au.id = c.imported_by_user_id
where p.id = c.participant_id
  and p.user_id = c.imported_by_user_id
  and (
    nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), '')
      is distinct from nullif(regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g'), '')
    or lower(nullif(trim(p.email), ''))
      is distinct from lower(nullif(trim(au.email), ''))
  );

insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
select
  'imported_order_buyer_corrected',
  'orders',
  c.order_id,
  c.event_id,
  jsonb_build_object(
    'import_batch_id', c.import_batch_id,
    'imported_by_user_id', c.imported_by_user_id,
    'imported_by_email', c.imported_by_email,
    'participant_id', c.participant_id,
    'ticket_id', ticket.id,
    'order_id', c.order_id,
    'previous_user_id', c.previous_user_id,
    'source', 'import',
    'correction_reason', c.correction_reason
  )
from legacy_imported_orders_to_correct c
left join lateral (
  select t.id
  from public.tickets t
  where t.order_id = c.order_id
  order by t.issued_at desc
  limit 1
) ticket on true;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from legacy_imported_orders_to_correct;
  raise notice 'Pedidos importados legados corrigidos: %', v_count;
end;
$$;

commit;
