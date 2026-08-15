-- 022_order_items_multi_ticket.sql
-- Estrutura inicial para multiplos ingressos por pedido com compatibilidade legada.

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event_id uuid not null references public.events(id),
  participant_id uuid references public.participants(id) on delete set null,
  ownership_status text not null default 'unassigned',
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
    where conname = 'order_items_ownership_status_check'
      and conrelid = 'public.order_items'::regclass
  ) then
    alter table public.order_items
      add constraint order_items_ownership_status_check
      check (ownership_status in ('unassigned', 'assigned', 'transferred', 'cancelled'));
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

drop index if exists public.ux_order_items_order_participant;

create index if not exists idx_order_items_order_participant
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
  ownership_status,
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
  case when o.participant_id is null then 'unassigned' else 'assigned' end as ownership_status,
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
comment on column public.order_items.participant_id is 'Titular opcional do ingresso. Pode permanecer nulo enquanto nao nominal.';
comment on column public.order_items.ownership_status is 'Titularidade do ingresso: unassigned, assigned, transferred, cancelled.';

alter table public.tickets
  alter column participant_id drop not null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'tickets_participant_id_fkey'
      and conrelid = 'public.tickets'::regclass
  ) then
    alter table public.tickets
      drop constraint tickets_participant_id_fkey;
  end if;

  alter table public.tickets
    add constraint tickets_participant_id_fkey
    foreign key (participant_id)
    references public.participants(id)
    on delete set null;
end
$$;

alter table public.tickets
  add column if not exists order_item_id uuid;

alter table public.tickets
  add column if not exists ownership_status text not null default 'unassigned';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tickets_ownership_status_check'
      and conrelid = 'public.tickets'::regclass
  ) then
    alter table public.tickets
      add constraint tickets_ownership_status_check
      check (ownership_status in ('unassigned', 'assigned', 'transferred', 'cancelled'));
  end if;
end
$$;

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

create unique index if not exists ux_tickets_order_item_id
  on public.tickets (order_item_id)
  where order_item_id is not null;

update public.tickets t
set order_item_id = oi.id
from public.order_items oi
where t.order_item_id is null
  and oi.order_id = t.order_id
  and oi.participant_id = t.participant_id;

update public.tickets
set ownership_status = case when participant_id is null then 'unassigned' else 'assigned' end
where ownership_status is null
   or ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled');

update public.tickets t
set ownership_status = oi.ownership_status
from public.order_items oi
where t.order_item_id = oi.id;

with duplicated_confirmed as (
  select
    id,
    row_number() over (
      partition by user_id, event_id
      order by created_at asc, id asc
    ) as rn
  from public.participation_history
  where user_id is not null
    and event_id is not null
    and status = 'confirmed'
)
update public.participation_history ph
set
  status = 'duplicate',
  updated_at = now()
from duplicated_confirmed dc
where ph.id = dc.id
  and dc.rn > 1;

create unique index if not exists ux_participation_history_user_event_confirmed
  on public.participation_history (user_id, event_id)
  where user_id is not null
    and event_id is not null
    and status = 'confirmed';

create or replace function public.recalculate_customer_loyalty(
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_confirmed_count integer := 0;
  v_current_profile public.customer_profiles%rowtype;
  v_target_tier public.loyalty_tiers%rowtype;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  select * into v_current_profile
  from public.customer_profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Perfil do cliente nao encontrado.';
  end if;

  if v_current_profile.loyalty_override and v_current_profile.loyalty_tier_id is not null then
    return v_current_profile.loyalty_tier_id;
  end if;

  select count(distinct ph.event_id)::integer into v_confirmed_count
  from public.participation_history ph
  where ph.user_id = p_user_id
    and ph.status = 'confirmed'
    and ph.event_id is not null;

  select * into v_target_tier
  from public.loyalty_tiers
  where min_confirmed_participations <= v_confirmed_count
  order by min_confirmed_participations desc, sort_order desc
  limit 1;

  if not found then
    select * into v_target_tier
    from public.loyalty_tiers
    order by min_confirmed_participations asc, sort_order asc
    limit 1;
  end if;

  update public.customer_profiles
  set
    loyalty_tier_id = v_target_tier.id,
    loyalty_updated_at = now(),
    updated_at = now()
  where user_id = p_user_id;

  insert into public.loyalty_history (
    user_id,
    loyalty_tier_id,
    confirmed_participations,
    source,
    reason
  ) values (
    p_user_id,
    v_target_tier.id,
    v_confirmed_count,
    'system',
    'recalculo automatico por historico confirmado deduplicado por evento'
  );

  return v_target_tier.id;
end;
$$;

create or replace function public.checkin_participant_entry(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if v_participant.user_id is not null and v_participant.event_id is not null then
    insert into public.participation_history (
      event_id,
      user_id,
      participant_id,
      legacy_event_name,
      event_year,
      full_name,
      normalized_name,
      cpf,
      email,
      status,
      source,
      manually_verified,
      created_at,
      updated_at
    )
    values (
      v_participant.event_id,
      v_participant.user_id,
      v_participant.id,
      null,
      extract(year from coalesce(v_participant.created_at, now()))::integer,
      coalesce(nullif(trim(v_participant.full_name), ''), 'Participante'),
      public.normalize_text_for_match(v_participant.full_name),
      v_participant.cpf,
      v_participant.email,
      'confirmed',
      'system',
      false,
      now(),
      now()
    )
    on conflict do nothing;

    perform public.recalculate_customer_loyalty(v_participant.user_id);
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

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

  select oi.id into v_order_item_id
  from public.order_items oi
  where oi.order_id = v_order_id
    and oi.participant_id = p_participant_id
  order by oi.created_at asc
  limit 1
  for update;

  if v_order_item_id is null then
    insert into public.order_items (
      order_id,
      event_id,
      participant_id,
      ownership_status,
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
      'assigned',
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
    ) returning id into v_order_item_id;
  else
    update public.order_items
    set
      event_id = v_participant.event_id,
      participant_id = p_participant_id,
      ownership_status = 'assigned',
      ticket_category_id = v_participant.ticket_category_id,
      batch_id = v_participant.batch_id,
      shirt_type = v_participant.shirt_type,
      shirt_size = v_participant.shirt_size,
      quantity = 1,
      unit_price = coalesce(v_payment.amount, 0),
      discount_amount = coalesce(v_payment.discount_amount, 0),
      final_amount = coalesce(v_payment.final_amount, v_payment.amount, 0),
      status = case
        when v_order_status = 'confirmed' then 'confirmed'
        when v_order_status = 'cancelled' then 'cancelled'
        when v_order_status = 'expired' then 'expired'
        when v_order_status = 'refunded' then 'refunded'
        else 'reserved'
      end,
      reservation_expires_at = v_participant.reservation_expires_at,
      updated_at = now()
    where id = v_order_item_id;
  end if;

  update public.tickets
  set
    order_item_id = v_order_item_id,
    ownership_status = 'assigned'
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

  select oi.id into v_order_item_id
  from public.order_items oi
  where oi.order_id = v_order.id
    and oi.participant_id = p_participant_id
  order by oi.created_at asc
  limit 1
  for update;

  if v_order_item_id is null then
    insert into public.order_items (
      order_id,
      event_id,
      participant_id,
      ownership_status,
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
      'assigned',
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
    ) returning id into v_order_item_id;
  else
    update public.order_items
    set
      event_id = v_participant.event_id,
      participant_id = p_participant_id,
      ownership_status = 'assigned',
      ticket_category_id = v_participant.ticket_category_id,
      batch_id = v_participant.batch_id,
      shirt_type = v_participant.shirt_type,
      shirt_size = v_participant.shirt_size,
      quantity = 1,
      unit_price = coalesce(v_payment.amount, 0),
      discount_amount = coalesce(v_payment.discount_amount, 0),
      final_amount = coalesce(v_payment.final_amount, v_payment.amount, 0),
      status = 'confirmed',
      reservation_expires_at = null,
      updated_at = now()
    where id = v_order_item_id;
  end if;

  insert into public.tickets (
    order_id,
    order_item_id,
    participant_id,
    event_id,
    ownership_status,
    status
  ) values (
    v_order.id,
    v_order_item_id,
    p_participant_id,
    v_participant.event_id,
    'assigned',
    'active'
  )
  on conflict (participant_id)
  do update set
    order_id = excluded.order_id,
    order_item_id = excluded.order_item_id,
    participant_id = excluded.participant_id,
    ownership_status = 'assigned',
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

create or replace function public.confirm_order_item_and_issue_ticket(
  p_order_item_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
begin
  if p_order_item_id is null then
    raise exception 'Order item obrigatorio.';
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

  select * into v_payment
  from public.payments
  where order_id = v_order.id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status <> 'paid' then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;

  update public.order_items
  set
    status = 'confirmed',
    ownership_status = case when participant_id is null then 'unassigned' else 'assigned' end,
    reservation_expires_at = null,
    updated_at = now()
  where id = v_item.id
  returning * into v_item;

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
    v_item.participant_id,
    v_item.event_id,
    v_item.ownership_status,
    'active'
  )
  on conflict (order_item_id) where order_item_id is not null
  do update set
    participant_id = excluded.participant_id,
    ownership_status = excluded.ownership_status,
    status = 'active',
    cancelled_at = null,
    used_at = null
  returning id into v_ticket_id;

  return v_ticket_id;
end;
$$;

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

  if auth.uid() is null or auth.uid() <> v_order.user_id then
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

  update public.order_items
  set
    participant_id = v_participant.id,
    ownership_status = 'assigned',
    updated_at = now()
  where id = v_item.id
  returning * into v_item;

  if v_item.status <> 'confirmed' then
    return null;
  end if;

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
    case when v_item.status = 'confirmed' then 'active' else 'cancelled' end
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
grant execute on function public.confirm_order_item_and_issue_ticket(uuid) to authenticated;
grant execute on function public.assign_order_item_participant(uuid, uuid) to authenticated;
