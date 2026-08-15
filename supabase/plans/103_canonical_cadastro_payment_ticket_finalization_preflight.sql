-- 103_canonical_cadastro_payment_ticket_finalization_preflight.sql
-- Estritamente somente leitura: estrutura, dependencias e ambiguidades da migration 103.

with structure as (
  select
    to_regclass('public.participants') is not null as has_participants,
    to_regclass('public.payments') is not null as has_payments,
    to_regclass('public.orders') is not null as has_orders,
    to_regclass('public.order_items') is not null as has_order_items,
    to_regclass('public.tickets') is not null as has_tickets,
    to_regprocedure('public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)') is not null as has_import_finalizer,
    to_regprocedure('public.confirm_order_and_issue_ticket(uuid)') is not null as has_regular_ticket_finalizer,
    to_regprocedure('public.simulate_payment_paid(uuid,text)') is not null as has_payment_confirmation,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_organization_guard
), required_columns as (
  select
    count(*) filter(where table_name='payments' and column_name in('id','participant_id','event_id','organization_id','payment_status'))=5 as payments_structure_ok,
    count(*) filter(where table_name='orders' and column_name in('id','participant_id','payment_id','event_id','organization_id'))=5 as orders_structure_ok,
    count(*) filter(where table_name='order_items' and column_name in('id','order_id','participant_id','event_id','batch_id'))=5 as order_items_structure_ok,
    count(*) filter(where table_name='tickets' and column_name in('id','order_id','order_item_id','participant_id','event_id','organization_id'))=6 as tickets_structure_ok
  from information_schema.columns
  where table_schema='public' and table_name in('payments','orders','order_items','tickets')
), participant_contexts as (
  select p.id as participant_id,p.event_id,p.organization_id,p.email,
    (select count(*) from public.payments pay where pay.participant_id=p.id and pay.event_id=p.event_id and pay.organization_id=p.organization_id)::integer as payment_count
  from public.participants p
), payment_contexts as (
  select pc.*,pay.id as payment_id,
    (select count(*) from public.orders o where o.participant_id=pc.participant_id and o.payment_id=pay.id and o.event_id=pc.event_id and o.organization_id=pc.organization_id)::integer as order_count
  from participant_contexts pc
  left join public.payments pay on pay.participant_id=pc.participant_id and pay.event_id=pc.event_id and pay.organization_id=pc.organization_id
), order_contexts as (
  select pc.*,o.id as order_id,
    (select count(*) from public.order_items oi where oi.order_id=o.id and oi.participant_id=pc.participant_id and oi.event_id=pc.event_id)::integer as item_count
  from payment_contexts pc
  left join public.orders o on o.participant_id=pc.participant_id and o.payment_id=pc.payment_id and o.event_id=pc.event_id and o.organization_id=pc.organization_id
), checkout_contexts as (
  select oc.*,oi.id as order_item_id,
    (select count(*) from public.tickets t where t.order_item_id=oi.id and t.order_id=oc.order_id and t.participant_id=oc.participant_id and t.event_id=oc.event_id)::integer as ticket_count
  from order_contexts oc
  left join public.order_items oi on oi.order_id=oc.order_id and oi.participant_id=oc.participant_id and oi.event_id=oc.event_id
), f2_participants as (
  select distinct ibr.matched_participant_id as participant_id
  from public.import_batch_rows ibr
  where ibr.matched_participant_id is not null and upper(coalesce(
    ibr.normalized_data->>'cenario_teste',ibr.normalized_data->>'cenário_teste',
    ibr.raw_data->>'cenario_teste',ibr.raw_data->>'cenário_teste',''))='F2'
), teste02_participants as (
  select p.id as participant_id from public.participants p where lower(coalesce(p.email,'')) like '%teste02%'
  union select p.id from auth.users au join public.participants p on p.user_id=au.id where lower(coalesce(au.email,'')) like '%teste02%'
), aggregate_counts as (
  select
    count(distinct participant_id) filter(where payment_count>1)::integer as contexts_with_multiple_payments,
    count(distinct participant_id) filter(where order_count>1)::integer as contexts_with_multiple_orders,
    count(distinct participant_id) filter(where item_count>1)::integer as contexts_with_multiple_items,
    count(distinct participant_id) filter(where ticket_count>1)::integer as contexts_with_multiple_tickets,
    count(distinct participant_id) filter(where payment_count=0)::integer as empty_context_count
  from checkout_contexts
), classifications as (
  select
    exists(select 1 from checkout_contexts c join f2_participants f using(participant_id)
      where c.payment_count=1 and c.order_count=1 and c.item_count=1 and c.ticket_count=1) as f2_is_complete_unique_checkout,
    exists(select 1 from checkout_contexts c join teste02_participants t using(participant_id)
      where c.payment_count>1 or c.order_count>1 or c.item_count>1 or c.ticket_count>1) as teste02_is_ambiguous_unchanged
)
select
  s.has_import_finalizer,s.has_regular_ticket_finalizer,s.has_payment_confirmation,
  s.has_permission_resolver,s.has_organization_guard,
  rc.payments_structure_ok,rc.orders_structure_ok,rc.order_items_structure_ok,rc.tickets_structure_ok,
  ac.contexts_with_multiple_payments,ac.contexts_with_multiple_orders,
  ac.contexts_with_multiple_items,ac.contexts_with_multiple_tickets,ac.empty_context_count,
  c.f2_is_complete_unique_checkout,c.teste02_is_ambiguous_unchanged,
  to_regprocedure('public.finalize_cadastro_payment_and_ticket(uuid,uuid,uuid,uuid)') is not null as finalizer_103_already_installed,
  to_regprocedure('public.get_cadastro_payment_ticket_context(uuid)') is not null as context_reader_103_already_installed,
  s.has_participants and s.has_payments and s.has_orders and s.has_order_items and s.has_tickets
    and s.has_import_finalizer and s.has_regular_ticket_finalizer and s.has_payment_confirmation
    and s.has_permission_resolver and s.has_organization_guard
    and rc.payments_structure_ok and rc.orders_structure_ok and rc.order_items_structure_ok and rc.tickets_structure_ok
    and c.f2_is_complete_unique_checkout and c.teste02_is_ambiguous_unchanged
    as safe_to_apply
from structure s cross join required_columns rc cross join aggregate_counts ac cross join classifications c;
