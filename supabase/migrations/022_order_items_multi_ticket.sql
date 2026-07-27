-- 022_order_items_multi_ticket.sql
-- Estrutura inicial para multiplos ingressos por pedido com compatibilidade legada.

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event_id uuid not null references public.events(id),
  participant_id uuid references public.participants(id) on delete set null,
  ticket_category_id uuid references public.ticket_categories(id),
  batch_id uuid references public.registration_batches(id),
  shirt_type text,
  shirt_size text,
  quantity integer not null default 1,
  unit_price numeric(10,2) not null,
  discount_amount numeric(10,2) not null default 0,
  final_amount numeric(10,2) not null,
  status text not null default 'reserved',
  reservation_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'order_items_status_check'
      and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_status_check
      check (status in ('reserved', 'confirmed', 'cancelled', 'expired', 'refunded', 'transferred'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'order_items_quantity_is_one_check'
      and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_quantity_is_one_check
      check (quantity = 1);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'order_items_prices_non_negative_check'
      and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_prices_non_negative_check
      check (
        unit_price >= 0
        and discount_amount >= 0
        and final_amount >= 0
      );
  end if;
end
$$;

create unique index if not exists ux_order_items_order_participant
  on public.order_items (order_id, participant_id);

create index if not exists idx_order_items_order_id
  on public.order_items (order_id);

create index if not exists idx_order_items_event_status
  on public.order_items (event_id, status);

create index if not exists idx_order_items_participant_id
  on public.order_items (participant_id);

create or replace function public.touch_order_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_order_items_updated_at on public.order_items;
create trigger trg_touch_order_items_updated_at
before update on public.order_items
for each row
execute function public.touch_order_items_updated_at();

insert into public.order_items (
  order_id,
  event_id,
  participant_id,
  ticket_category_id,
  batch_id,
  shirt_type,
  shirt_size,
  quantity,
  unit_price,
  discount_amount,
  final_amount,
  status,
  reservation_expires_at
)
select
  o.id as order_id,
  o.event_id,
  o.participant_id,
  p.ticket_category_id,
  p.batch_id,
  p.shirt_type,
  p.shirt_size,
  1 as quantity,
  coalesce(o.base_amount, 0) as unit_price,
  coalesce(o.discount_amount, 0) as discount_amount,
  coalesce(o.final_amount, o.base_amount, 0) as final_amount,
  case
    when o.status = 'confirmed' then 'confirmed'
    when o.status = 'cancelled' then 'cancelled'
    when o.status = 'expired' then 'expired'
    when o.status = 'refunded' then 'refunded'
    else 'reserved'
  end as status,
  p.reservation_expires_at
from public.orders o
left join public.participants p
  on p.id = o.participant_id
where not exists (
  select 1
  from public.order_items oi
  where oi.order_id = o.id
    and oi.participant_id is not distinct from o.participant_id
);

comment on column public.orders.participant_id is 'LEGACY compatibility field. New purchases should use public.order_items.participant_id.';
comment on column public.orders.base_amount is 'LEGACY compatibility total. New purchases should aggregate public.order_items.unit_price.';
comment on column public.orders.discount_amount is 'LEGACY compatibility total. New purchases should aggregate public.order_items.discount_amount.';
comment on column public.orders.final_amount is 'LEGACY compatibility total. New purchases should aggregate public.order_items.final_amount.';

alter table public.tickets
  add column if not exists order_item_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tickets_order_item_id_fkey'
      and conrelid = 'public.tickets'::regclass
  ) then
    alter table public.tickets
      add constraint tickets_order_item_id_fkey
      foreign key (order_item_id)
      references public.order_items(id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_tickets_order_item_id
  on public.tickets (order_item_id);

update public.tickets t
set order_item_id = oi.id
from public.order_items oi
where t.order_item_id is null
  and oi.order_id = t.order_id
  and oi.participant_id = t.participant_id;

create or replace function public.ensure_order_for_participant(
  p_participant_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_user_id uuid;
  v_order_status text;
  v_order_item_id uuid;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  v_user_id := coalesce(p_user_id, v_participant.user_id);
  if v_user_id is null then
    raise exception 'Usuario da conta obrigatorio para criar pedido.';
  end if;

  if v_participant.user_id is null then
    update public.participants
    set user_id = v_user_id,
        updated_at = now()
    where id = v_participant.id;
  elsif v_participant.user_id <> v_user_id then
    raise exception 'Participante ja vinculado a outro usuario.';
  end if;

  select * into v_payment
  from public.payments
  where participant_id = p_participant_id
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  select o.id into v_order_id
  from public.orders o
  where o.participant_id = p_participant_id
  limit 1;

  v_order_status := case
    when v_payment.payment_status = 'paid' then 'confirmed'
    when v_payment.payment_status = 'cancelled' then 'cancelled'
    when v_payment.payment_status = 'expired' then 'expired'
    when v_payment.payment_status = 'refunded' then 'refunded'
    else 'pending'
  end;

  if v_order_id is null then
    v_order_number := public.generate_order_number();

    insert into public.orders (
      user_id,
      participant_id,
      event_id,
      payment_id,
      order_number,
      status,
      base_amount,
      discount_amount,
      final_amount
    ) values (
      v_user_id,
      p_participant_id,
      v_participant.event_id,
      v_payment.id,
      v_order_number,
      v_order_status,
      coalesce(v_payment.amount, 0),
      coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount, 0)
    ) returning id into v_order_id;
  else
    update public.orders
    set
      user_id = v_user_id,
      event_id = v_participant.event_id,
      payment_id = v_payment.id,
      status = case
        when v_payment.payment_status = 'paid' and status <> 'refunded' then 'confirmed'
        when v_payment.payment_status = 'cancelled' then 'cancelled'
        when v_payment.payment_status = 'expired' then 'expired'
        when v_payment.payment_status = 'refunded' then 'refunded'
        else status
      end,
      base_amount = coalesce(v_payment.amount, 0),
      discount_amount = coalesce(v_payment.discount_amount, 0),
      final_amount = coalesce(v_payment.final_amount, v_payment.amount, 0),
      confirmed_at = case
        when v_payment.payment_status = 'paid' and confirmed_at is null then now()
        else confirmed_at
      end,
      cancelled_at = case
        when v_payment.payment_status in ('cancelled', 'refunded') and cancelled_at is null then now()
        else cancelled_at
      end
    where id = v_order_id;
  end if;

  update public.payments
  set order_id = v_order_id
  where id = v_payment.id;

  insert into public.order_items (
    order_id,
    event_id,
    participant_id,
    ticket_category_id,
    batch_id,
    shirt_type,
    shirt_size,
    quantity,
    unit_price,
    discount_amount,
    final_amount,
    status,
    reservation_expires_at
  ) values (
    v_order_id,
    v_participant.event_id,
    p_participant_id,
    v_participant.ticket_category_id,
    v_participant.batch_id,
    v_participant.shirt_type,
    v_participant.shirt_size,
    1,
    coalesce(v_payment.amount, 0),
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount, 0),
    case
      when v_order_status = 'confirmed' then 'confirmed'
      when v_order_status = 'cancelled' then 'cancelled'
      when v_order_status = 'expired' then 'expired'
      when v_order_status = 'refunded' then 'refunded'
      else 'reserved'
    end,
    v_participant.reservation_expires_at
  )
  on conflict (order_id, participant_id)
  do update set
    event_id = excluded.event_id,
    ticket_category_id = excluded.ticket_category_id,
    batch_id = excluded.batch_id,
    shirt_type = excluded.shirt_type,
    shirt_size = excluded.shirt_size,
    quantity = 1,
    unit_price = excluded.unit_price,
    discount_amount = excluded.discount_amount,
    final_amount = excluded.final_amount,
    status = excluded.status,
    reservation_expires_at = excluded.reservation_expires_at,
    updated_at = now()
  returning id into v_order_item_id;

  update public.tickets
  set order_item_id = v_order_item_id
  where order_id = v_order_id
    and participant_id = p_participant_id
    and order_item_id is null;

  return v_order_id;
end;
$$;

create or replace function public.confirm_order_and_issue_ticket(
  p_participant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_ticket_id uuid;
  v_order_item_id uuid;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments
  where participant_id = p_participant_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado.';
  end if;

  if v_payment.payment_status <> 'paid' then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;

  select * into v_order
  from public.orders
  where participant_id = p_participant_id
  limit 1
  for update;

  if not found then
    raise exception 'Pedido nao encontrado para o participante.';
  end if;

  update public.orders
  set
    payment_id = v_payment.id,
    status = 'confirmed',
    confirmed_at = coalesce(confirmed_at, now()),
    cancelled_at = null
  where id = v_order.id;

  insert into public.order_items (
    order_id,
    event_id,
    participant_id,
    ticket_category_id,
    batch_id,
    shirt_type,
    shirt_size,
    quantity,
    unit_price,
    discount_amount,
    final_amount,
    status,
    reservation_expires_at
  ) values (
    v_order.id,
    v_participant.event_id,
    p_participant_id,
    v_participant.ticket_category_id,
    v_participant.batch_id,
    v_participant.shirt_type,
    v_participant.shirt_size,
    1,
    coalesce(v_payment.amount, 0),
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount, 0),
    'confirmed',
    null
  )
  on conflict (order_id, participant_id)
  do update set
    event_id = excluded.event_id,
    ticket_category_id = excluded.ticket_category_id,
    batch_id = excluded.batch_id,
    shirt_type = excluded.shirt_type,
    shirt_size = excluded.shirt_size,
    quantity = 1,
    unit_price = excluded.unit_price,
    discount_amount = excluded.discount_amount,
    final_amount = excluded.final_amount,
    status = 'confirmed',
    reservation_expires_at = null,
    updated_at = now()
  returning id into v_order_item_id;

  insert into public.tickets (
    order_id,
    order_item_id,
    participant_id,
    event_id,
    status
  ) values (
    v_order.id,
    v_order_item_id,
    p_participant_id,
    v_participant.event_id,
    'active'
  )
  on conflict (participant_id)
  do update set
    order_id = excluded.order_id,
    order_item_id = excluded.order_item_id,
    status = 'active',
    cancelled_at = null,
    used_at = null
  returning id into v_ticket_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'ticket_issued',
    'tickets',
    v_ticket_id,
    v_participant.event_id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'order_id', v_order.id,
      'order_item_id', v_order_item_id,
      'payment_id', v_payment.id
    )
  );

  return v_ticket_id;
end;
$$;

alter table public.order_items enable row level security;

drop policy if exists "order_items_owner_select" on public.order_items;
create policy "order_items_owner_select"
on public.order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = order_items.order_id
      and o.user_id = auth.uid()
  )
);

grant select on table public.order_items to authenticated;
