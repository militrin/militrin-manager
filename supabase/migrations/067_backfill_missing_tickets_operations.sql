-- 067_backfill_missing_tickets_operations.sql
-- Backfill de ingressos ausentes para participantes operacionais sem ticket.
-- Regras:
-- 1) participante com event_id, nao cancelado e sem ticket
-- 2) pedido + item do pedido + pagamento confirmado
-- 3) categoria valida via order_items.ticket_category_id ou participants.ticket_category_id
-- 4) sem inventar categoria silenciosamente

begin;

with candidate_participants as (
  select
    p.id as participant_id,
    p.event_id,
    p.registration_status,
    p.ticket_category_id as participant_ticket_category_id
  from public.participants p
  where p.event_id is not null
    and coalesce(p.registration_status, 'pending') <> 'cancelled'
    and not exists (
      select 1
      from public.tickets t
      where t.participant_id = p.id
    )
),
resolved_paths as (
  select
    cp.participant_id,
    cp.event_id,
    o.id as order_id,
    oi.id as order_item_id,
    coalesce(oi.ticket_category_id, cp.participant_ticket_category_id) as resolved_ticket_category_id,
    exists (
      select 1
      from public.payments pay
      where pay.order_id = o.id
        and pay.payment_status = 'paid'
    ) as has_paid_payment
  from candidate_participants cp
  left join lateral (
    select o1.id
    from public.orders o1
    where o1.event_id = cp.event_id
      and o1.participant_id = cp.participant_id
    order by o1.created_at asc
    limit 1
  ) o on true
  left join lateral (
    select oi1.id, oi1.ticket_category_id
    from public.order_items oi1
    where oi1.order_id = o.id
      and oi1.participant_id = cp.participant_id
    order by oi1.created_at asc
    limit 1
  ) oi on true
),
classified as (
  select
    rp.*,
    case
      when rp.order_id is null then 'missing_order'
      when rp.order_item_id is null then 'missing_order_item'
      when rp.has_paid_payment is false then 'missing_paid_payment'
      when rp.resolved_ticket_category_id is null then 'missing_ticket_category'
      when not exists (
        select 1
        from public.ticket_categories tc
        where tc.id = rp.resolved_ticket_category_id
          and tc.event_id = rp.event_id
      ) then 'invalid_ticket_category_for_event'
      else null
    end as unresolved_reason
  from resolved_paths rp
),
backfillable as (
  select *
  from classified
  where unresolved_reason is null
),
inserted as (
  insert into public.tickets (
    order_id,
    order_item_id,
    participant_id,
    event_id,
    status,
    issued_at
  )
  select
    b.order_id,
    b.order_item_id,
    b.participant_id,
    b.event_id,
    'active',
    now()
  from backfillable b
  on conflict (order_item_id) where order_item_id is not null
  do update set
    order_id = excluded.order_id,
    participant_id = excluded.participant_id,
    event_id = excluded.event_id,
    status = 'active',
    cancelled_at = null,
    used_at = null
  returning id, participant_id, order_id, order_item_id, event_id
),
audit_issued as (
  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  select
    'ticket_backfill_missing',
    'tickets',
    i.id,
    i.event_id,
    jsonb_build_object(
      'actor', 'system',
      'participant_id', i.participant_id,
      'order_id', i.order_id,
      'order_item_id', i.order_item_id,
      'migration', '067_backfill_missing_tickets_operations'
    )
  from inserted i
  returning id
),
audit_unresolved as (
  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  select
    'ticket_backfill_missing_unresolved',
    'participants',
    c.participant_id,
    c.event_id,
    jsonb_build_object(
      'actor', 'system',
      'participant_id', c.participant_id,
      'order_id', c.order_id,
      'order_item_id', c.order_item_id,
      'reason', c.unresolved_reason,
      'migration', '067_backfill_missing_tickets_operations'
    )
  from classified c
  where c.unresolved_reason is not null
  returning id
)
select
  (select count(*) from candidate_participants) as candidates_without_ticket,
  (select count(*) from inserted) as tickets_backfilled,
  (select count(*) from classified where unresolved_reason is not null) as unresolved_count;

commit;
