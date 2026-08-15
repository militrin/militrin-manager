-- 086_unify_ticket_participant_source.sql
-- order_items.participant_id e a fonte canonica do titular; tickets e sincronizado.

begin;

create temporary table ticket_participant_link_diagnostic on commit drop as
select t.id ticket_id, t.order_item_id,
  t.participant_id ticket_participant_id,
  oi.participant_id order_item_participant_id,
  o.participant_id legacy_order_participant_id,
  oi.holder_full_name,
  case
    when oi.participant_id is not null then oi.participant_id
    when t.participant_id is not null then t.participant_id
    when o.participant_id is not null and (
      (select count(*) from public.order_items x where x.order_id = o.id) = 1
      or lower(trim(coalesce(oi.holder_full_name, ''))) = lower(trim(coalesce(p.full_name, '')))
    ) then o.participant_id
    else null
  end resolved_participant_id,
  case
    when oi.participant_id is not null then 'order_items.participant_id'
    when t.participant_id is not null then 'tickets.participant_id legado'
    when o.participant_id is not null and (select count(*) from public.order_items x where x.order_id = o.id) = 1
      then 'orders.participant_id legado; pedido com item unico'
    when o.participant_id is not null
      and lower(trim(coalesce(oi.holder_full_name, ''))) = lower(trim(coalesce(p.full_name, '')))
      then 'orders.participant_id legado; nome confere'
    else 'sem vinculo uuid comprovavel'
  end resolution_reason
from public.tickets t
left join public.order_items oi on oi.id = t.order_item_id
left join public.orders o on o.id = coalesce(oi.order_id, t.order_id)
left join public.participants p on p.id = o.participant_id
where t.order_item_id is not null
  and (t.participant_id is distinct from oi.participant_id or oi.participant_id is null);

select * from ticket_participant_link_diagnostic order by ticket_id;

update public.order_items oi
set participant_id = d.resolved_participant_id,
    ownership_status = 'assigned', updated_at = now()
from ticket_participant_link_diagnostic d
where oi.id = d.order_item_id and oi.participant_id is null
  and d.resolved_participant_id is not null;

update public.tickets t
set participant_id = oi.participant_id,
    ownership_status = case when oi.participant_id is null then 'unassigned' else 'assigned' end
from public.order_items oi
where t.order_item_id = oi.id and t.participant_id is distinct from oi.participant_id;

create or replace function public.sync_ticket_participant_from_order_item()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_participant_id uuid;
begin
  if new.order_item_id is null then return new; end if;
  select participant_id into v_participant_id from public.order_items where id = new.order_item_id;
  new.participant_id := v_participant_id;
  new.ownership_status := case when v_participant_id is null then 'unassigned' else 'assigned' end;
  return new;
end;
$$;

drop trigger if exists trg_ticket_participant_from_order_item on public.tickets;
create trigger trg_ticket_participant_from_order_item
before insert or update of order_item_id, participant_id on public.tickets
for each row execute function public.sync_ticket_participant_from_order_item();

create or replace function public.sync_order_item_participant_to_ticket()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tickets
  set participant_id = new.participant_id,
      ownership_status = case when new.participant_id is null then 'unassigned' else 'assigned' end
  where order_item_id = new.id and participant_id is distinct from new.participant_id;
  return new;
end;
$$;

drop trigger if exists trg_order_item_participant_to_ticket on public.order_items;
create trigger trg_order_item_participant_to_ticket
after insert or update of participant_id on public.order_items
for each row execute function public.sync_order_item_participant_to_ticket();

create or replace function public.materialize_participant_kit_items(p_ticket_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order_item_id uuid; v_participant_id uuid;
begin
  select order_item_id into v_order_item_id from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if v_order_item_id is null then raise exception 'Ingresso sem item de pedido vinculado.'; end if;
  select participant_id into v_participant_id from public.order_items where id = v_order_item_id for update;
  if v_participant_id is null then raise exception 'Ingresso sem participante vinculado.'; end if;
  update public.tickets set participant_id = v_participant_id, ownership_status = 'assigned'
  where id = p_ticket_id and participant_id is distinct from v_participant_id;
  return public.materialize_participant_kit_items_internal(p_ticket_id, 'operations_manual');
end;
$$;

revoke all on function public.materialize_participant_kit_items(uuid) from public, anon, authenticated;
grant execute on function public.materialize_participant_kit_items(uuid) to authenticated;

commit;
