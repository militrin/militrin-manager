-- 016_customer_accounts.sql
-- Auth de clientes + perfil, pedidos e ingressos do portal publico.

create extension if not exists pgcrypto;

alter table public.participants
  add column if not exists user_id uuid references auth.users(id) on delete set null;

update public.participants
set email = lower(trim(email))
where email is not null;

alter table public.participants
  drop constraint if exists participants_email_required_chk;

alter table public.participants
  add constraint participants_email_required_chk
  check (email is not null and btrim(email) <> '') not valid;

create index if not exists idx_participants_user_id
  on public.participants (user_id);

create index if not exists idx_participants_email
  on public.participants (lower(email));

create index if not exists idx_participants_event_email
  on public.participants (event_id, lower(email));

create table if not exists public.customer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  cpf text,
  birth_date date,
  gender text,
  phone text,
  city text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_customer_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_customer_profiles_updated_at on public.customer_profiles;
create trigger trg_touch_customer_profiles_updated_at
before update on public.customer_profiles
for each row
execute function public.touch_customer_profiles_updated_at();

create sequence if not exists public.order_number_seq start 1000;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id uuid not null references public.events(id),
  payment_id uuid references public.payments(id) on delete set null,
  order_number text not null unique,
  status text not null,
  base_amount numeric(10,2) not null,
  discount_amount numeric(10,2) not null default 0,
  final_amount numeric(10,2) not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  constraint orders_status_check check (status in ('pending', 'confirmed', 'expired', 'cancelled', 'refunded'))
);

create unique index if not exists ux_orders_participant_id
  on public.orders (participant_id);

create index if not exists idx_orders_user_created
  on public.orders (user_id, created_at desc);

create index if not exists idx_orders_event
  on public.orders (event_id);

alter table public.payments
  add column if not exists order_id uuid references public.orders(id) on delete set null;

create index if not exists idx_payments_order_id
  on public.payments (order_id);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id uuid not null references public.events(id),
  token uuid not null default gen_random_uuid() unique,
  status text not null default 'active',
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  cancelled_at timestamptz,
  constraint tickets_status_check check (status in ('active', 'used', 'cancelled'))
);

create unique index if not exists ux_tickets_participant_id
  on public.tickets (participant_id);

create index if not exists idx_tickets_order_id
  on public.tickets (order_id);

create index if not exists idx_tickets_event_id
  on public.tickets (event_id);

create or replace function public.generate_order_number()
returns text
language sql
as $$
  select 'MIL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.order_number_seq')::text, 8, '0');
$$;

create or replace function public.upsert_customer_profile(
  p_user_id uuid,
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_city text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  insert into public.customer_profiles (
    user_id,
    full_name,
    cpf,
    birth_date,
    gender,
    phone,
    city
  ) values (
    p_user_id,
    nullif(trim(coalesce(p_full_name, '')), ''),
    nullif(trim(coalesce(p_cpf, '')), ''),
    p_birth_date,
    nullif(trim(coalesce(p_gender, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_city, '')), '')
  )
  on conflict (user_id)
  do update set
    full_name = excluded.full_name,
    cpf = excluded.cpf,
    birth_date = excluded.birth_date,
    gender = excluded.gender,
    phone = excluded.phone,
    city = excluded.city,
    updated_at = now();

  return true;
end;
$$;

create or replace function public.get_customer_profile(
  p_user_id uuid default auth.uid()
)
returns table (
  user_id uuid,
  full_name text,
  cpf text,
  birth_date date,
  gender text,
  phone text,
  city text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    cp.user_id,
    cp.full_name,
    cp.cpf,
    cp.birth_date,
    cp.gender,
    cp.phone,
    cp.city,
    cp.created_at,
    cp.updated_at
  from public.customer_profiles cp
  where cp.user_id = p_user_id;
$$;

create or replace function public.get_public_account_email_status(
  p_email text
)
returns table (
  has_account boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.participants p
    where lower(p.email) = lower(trim(coalesce(p_email, '')))
      and p.user_id is not null
  ) as has_account;
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
      case when v_payment.payment_status = 'paid' then 'confirmed' else 'pending' end,
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

  insert into public.tickets (
    order_id,
    participant_id,
    event_id,
    status
  ) values (
    v_order.id,
    p_participant_id,
    v_participant.event_id,
    'active'
  )
  on conflict (participant_id)
  do update set
    order_id = excluded.order_id,
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
      'payment_id', v_payment.id
    )
  );

  return v_ticket_id;
end;
$$;

alter table public.customer_profiles enable row level security;
alter table public.orders enable row level security;
alter table public.tickets enable row level security;

-- Remove politicas amplas legadas para acesso do participante autenticado.
drop policy if exists "Authenticated users can read participants" on public.participants;
drop policy if exists "Authenticated users can insert participants" on public.participants;
drop policy if exists "Authenticated users can update participants" on public.participants;
drop policy if exists "Authenticated users can delete participants" on public.participants;

drop policy if exists "Authenticated users can read payments" on public.payments;
drop policy if exists "Authenticated users can insert payments" on public.payments;
drop policy if exists "Authenticated users can update payments" on public.payments;
drop policy if exists "Authenticated users can delete payments" on public.payments;

drop policy if exists "participant_kit_items_read_only" on public.participant_kit_items;

drop policy if exists "participants_owner_select" on public.participants;

create policy "participants_owner_select"
on public.participants
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "participants_owner_update" on public.participants;

create policy "participants_owner_update"
on public.participants
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "payments_owner_select" on public.payments;

create policy "payments_owner_select"
on public.payments
for select
to authenticated
using (
  exists (
    select 1
    from public.participants p
    where p.id = payments.participant_id
      and p.user_id = auth.uid()
  )
);

drop policy if exists "customer_profiles_owner_select" on public.customer_profiles;

create policy "customer_profiles_owner_select"
on public.customer_profiles
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "customer_profiles_owner_insert" on public.customer_profiles;

create policy "customer_profiles_owner_insert"
on public.customer_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "customer_profiles_owner_update" on public.customer_profiles;

create policy "customer_profiles_owner_update"
on public.customer_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "orders_owner_select" on public.orders;

create policy "orders_owner_select"
on public.orders
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "tickets_owner_select" on public.tickets;

create policy "tickets_owner_select"
on public.tickets
for select
to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = tickets.order_id
      and o.user_id = auth.uid()
  )
);

drop policy if exists "participant_kit_items_owner_select" on public.participant_kit_items;

create policy "participant_kit_items_owner_select"
on public.participant_kit_items
for select
to authenticated
using (
  exists (
    select 1
    from public.participants p
    where p.id = participant_kit_items.participant_id
      and p.user_id = auth.uid()
  )
);

revoke all on function public.upsert_customer_profile(uuid, text, text, date, text, text, text) from public, anon, authenticated;
revoke all on function public.get_customer_profile(uuid) from public, anon, authenticated;
revoke all on function public.get_public_account_email_status(text) from public, anon, authenticated;
revoke all on function public.ensure_order_for_participant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.confirm_order_and_issue_ticket(uuid) from public, anon, authenticated;

grant execute on function public.upsert_customer_profile(uuid, text, text, date, text, text, text) to authenticated;
grant execute on function public.get_customer_profile(uuid) to authenticated;
grant execute on function public.get_public_account_email_status(text) to anon, authenticated;
grant execute on function public.ensure_order_for_participant(uuid, uuid) to authenticated;
grant execute on function public.confirm_order_and_issue_ticket(uuid) to authenticated;
