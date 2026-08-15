-- 010_registration_batches_schema.sql
-- Schema de lotes de inscricao e colunas de precificacao em participants.

create table if not exists public.registration_batches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  name text not null,
  sequence_number integer not null,
  male_price numeric(10,2) not null,
  female_price numeric(10,2) not null,
  max_confirmed_registrations integer not null,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_batches_sequence_unique unique (event_id, sequence_number),
  constraint registration_batches_male_price_non_negative check (male_price >= 0),
  constraint registration_batches_female_price_non_negative check (female_price >= 0),
  constraint registration_batches_limit_positive check (max_confirmed_registrations > 0),
  constraint registration_batches_time_window check (starts_at is null or ends_at is null or starts_at <= ends_at)
);

create unique index if not exists ux_registration_batches_single_active
  on public.registration_batches (event_id)
  where is_active;

create index if not exists idx_registration_batches_event_sequence
  on public.registration_batches (event_id, sequence_number);

alter table public.participants
  add column if not exists batch_id uuid references public.registration_batches(id),
  add column if not exists base_amount numeric(10,2),
  add column if not exists discount_amount numeric(10,2) not null default 0,
  add column if not exists final_amount numeric(10,2);

-- Backfill idempotente: suporta bancos com ou sem participants.amount.
do $$
declare
  v_has_participants_amount boolean;
  v_has_payments_amount boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'participants'
      and column_name = 'amount'
  ) into v_has_participants_amount;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payments'
      and column_name = 'amount'
  ) into v_has_payments_amount;

  if v_has_participants_amount then
    execute $sql$
      update public.participants p
      set
        base_amount = coalesce(p.base_amount, p.amount, 0),
        discount_amount = coalesce(p.discount_amount, 0),
        final_amount = coalesce(p.final_amount, p.amount, 0)
      where p.base_amount is null
         or p.final_amount is null
         or p.discount_amount is null
    $sql$;
  elsif v_has_payments_amount then
    update public.participants p
    set
      base_amount = coalesce(p.base_amount, pay.amount, 0),
      discount_amount = coalesce(p.discount_amount, 0),
      final_amount = coalesce(p.final_amount, pay.amount, coalesce(p.base_amount, 0))
    from (
      select participant_id, max(amount) as amount
      from public.payments
      group by participant_id
    ) as pay
    where pay.participant_id = p.id
      and (p.base_amount is null or p.final_amount is null or p.discount_amount is null);

    update public.participants p
    set
      base_amount = coalesce(p.base_amount, 0),
      discount_amount = coalesce(p.discount_amount, 0),
      final_amount = coalesce(p.final_amount, p.base_amount, 0)
    where p.base_amount is null
       or p.final_amount is null
       or p.discount_amount is null;
  else
    update public.participants p
    set
      base_amount = coalesce(p.base_amount, 0),
      discount_amount = coalesce(p.discount_amount, 0),
      final_amount = coalesce(p.final_amount, p.base_amount, 0)
    where p.base_amount is null
       or p.final_amount is null
       or p.discount_amount is null;
  end if;
end;
$$;
