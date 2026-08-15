-- 077_ticket_buyer_holder_ownership.sql
-- Separa propriedade da compra (orders.user_id) da titularidade do ingresso.

begin;

create or replace function public.get_operation_buyers(
  p_event_id uuid
)
returns table (
  user_id uuid,
  full_name text,
  cpf text,
  phone text,
  email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_organization_id uuid;
begin
  if v_actor_user_id is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select e.organization_id
  into v_organization_id
  from public.events e
  where e.id = p_event_id;

  if v_organization_id is null then
    raise exception 'Evento nao encontrado.';
  end if;

  if not public.user_can_access_organization(v_actor_user_id, v_organization_id)
    or not (
      public.is_active_owner(v_actor_user_id)
      or public.resolve_user_permission(v_actor_user_id, 'participants.view')
    ) then
    raise exception 'Usuario sem permissao para consultar compradores deste evento.';
  end if;

  return query
  select distinct
    cp.user_id,
    cp.full_name,
    cp.cpf,
    cp.phone,
    lower(au.email)
  from public.orders o
  join public.customer_profiles cp on cp.user_id = o.user_id
  join auth.users au on au.id = o.user_id
  where o.event_id = p_event_id;
end;
$$;

revoke all on function public.get_operation_buyers(uuid) from public, anon, authenticated;
grant execute on function public.get_operation_buyers(uuid) to authenticated;

drop policy if exists tickets_holder_select on public.tickets;
create policy tickets_holder_select
on public.tickets
for select
to authenticated
using (
  participant_id is not null
  and exists (
    select 1
    from public.participants p
    where p.id = tickets.participant_id
      and p.user_id = auth.uid()
  )
);

drop policy if exists order_items_holder_select on public.order_items;
create policy order_items_holder_select
on public.order_items
for select
to authenticated
using (
  participant_id is not null
  and exists (
    select 1
    from public.participants p
    where p.id = order_items.participant_id
      and p.user_id = auth.uid()
  )
);

create or replace function public.user_is_order_item_holder(
  p_user_id uuid,
  p_order_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.order_items oi
    join public.participants p on p.id = oi.participant_id
    where oi.order_id = p_order_id
      and p.user_id = p_user_id
  );
$$;

revoke all on function public.user_is_order_item_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_is_order_item_holder(uuid, uuid) to authenticated;

drop policy if exists orders_holder_select on public.orders;
create policy orders_holder_select
on public.orders
for select
to authenticated
using (
  public.user_is_order_item_holder(auth.uid(), id)
);

create or replace function public.assign_order_item_participant(
  p_order_item_id uuid,
  p_participant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.order_items%rowtype;
  v_participant public.participants%rowtype;
  v_order public.orders%rowtype;
  v_ticket_id uuid;
  v_previous_participant_id uuid;
  v_actor_user_id uuid := auth.uid();
begin
  if p_order_item_id is null or p_participant_id is null then
    raise exception 'Order item e participante sao obrigatorios.';
  end if;

  select * into v_item
  from public.order_items
  where id = p_order_item_id
  for update;

  if not found then
    raise exception 'Order item nao encontrado.';
  end if;

  select * into v_order
  from public.orders
  where id = v_item.order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado para o order item.';
  end if;

  if v_actor_user_id is null or v_actor_user_id <> v_order.user_id then
    raise exception 'Usuario sem permissao para atribuir este ingresso.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if v_participant.event_id <> v_item.event_id then
    raise exception 'Participante de evento diferente do ingresso.';
  end if;

  v_previous_participant_id := v_item.participant_id;

  update public.order_items
  set
    participant_id = v_participant.id,
    holder_full_name = v_participant.full_name,
    ownership_status = 'assigned',
    updated_at = now()
  where id = v_item.id
  returning * into v_item;

  select t.id
  into v_ticket_id
  from public.tickets t
  where t.order_item_id = v_item.id
  for update;

  if v_item.status = 'confirmed' then
    insert into public.tickets (
      order_id,
      order_item_id,
      participant_id,
      event_id,
      ownership_status,
      status
    ) values (
      v_order.id,
      v_item.id,
      v_participant.id,
      v_item.event_id,
      'assigned',
      'active'
    )
    on conflict (order_item_id) where order_item_id is not null
    do update set
      participant_id = excluded.participant_id,
      ownership_status = excluded.ownership_status,
      status = case
        when public.tickets.status in ('active', 'used') then public.tickets.status
        else excluded.status
      end,
      cancelled_at = case
        when public.tickets.status in ('active', 'used') then public.tickets.cancelled_at
        else null
      end
    returning id into v_ticket_id;
  elsif v_ticket_id is not null then
    update public.tickets
    set
      participant_id = v_participant.id,
      ownership_status = 'assigned'
    where id = v_ticket_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_holder_assigned',
    case when v_ticket_id is null then 'order_items' else 'tickets' end,
    coalesce(v_ticket_id, v_item.id),
    v_item.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'buyer_user_id', v_order.user_id,
      'order_id', v_order.id,
      'order_item_id', v_item.id,
      'ticket_id', v_ticket_id,
      'previous_participant_id', v_previous_participant_id,
      'participant_id', v_participant.id,
      'holder_full_name', v_participant.full_name
    )
  );

  return v_ticket_id;
end;
$$;

revoke all on function public.assign_order_item_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_order_item_participant(uuid, uuid) to authenticated;

commit;
