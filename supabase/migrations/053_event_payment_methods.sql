-- Configuracao de formas de pagamento por evento.

create table if not exists public.event_payment_methods (
  event_id uuid primary key references public.events(id) on delete cascade,
  pix_enabled boolean not null default true,
  credit_card_single_enabled boolean not null default true,
  credit_card_installments_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_payment_methods_at_least_one
    check (pix_enabled or credit_card_single_enabled or credit_card_installments_enabled)
);

create or replace function public.get_event_payment_methods_setup(
  p_event_id uuid
)
returns table (
  event_id uuid,
  pix_enabled boolean,
  credit_card_single_enabled boolean,
  credit_card_installments_enabled boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id as event_id,
    coalesce(epm.pix_enabled, true) as pix_enabled,
    coalesce(epm.credit_card_single_enabled, true) as credit_card_single_enabled,
    coalesce(epm.credit_card_installments_enabled, true) as credit_card_installments_enabled
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;
$$;

create or replace function public.upsert_event_payment_methods(
  p_event_id uuid,
  p_pix_enabled boolean default true,
  p_credit_card_single_enabled boolean default true,
  p_credit_card_installments_enabled boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  if not coalesce(p_pix_enabled, false)
     and not coalesce(p_credit_card_single_enabled, false)
     and not coalesce(p_credit_card_installments_enabled, false) then
    raise exception 'Selecione pelo menos uma forma de pagamento.';
  end if;

  insert into public.event_payment_methods (
    event_id,
    pix_enabled,
    credit_card_single_enabled,
    credit_card_installments_enabled,
    created_at,
    updated_at
  )
  values (
    p_event_id,
    coalesce(p_pix_enabled, true),
    coalesce(p_credit_card_single_enabled, true),
    coalesce(p_credit_card_installments_enabled, true),
    now(),
    now()
  )
  on conflict (event_id) do update
  set
    pix_enabled = excluded.pix_enabled,
    credit_card_single_enabled = excluded.credit_card_single_enabled,
    credit_card_installments_enabled = excluded.credit_card_installments_enabled,
    updated_at = now();
end;
$$;

create or replace function public.is_event_payment_method_allowed(
  p_event_id uuid,
  p_payment_method text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_pix_enabled boolean := true;
  v_credit_single_enabled boolean := true;
  v_credit_installments_enabled boolean := true;
begin
  select
    coalesce(epm.pix_enabled, true),
    coalesce(epm.credit_card_single_enabled, true),
    coalesce(epm.credit_card_installments_enabled, true)
  into
    v_pix_enabled,
    v_credit_single_enabled,
    v_credit_installments_enabled
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;

  if v_method = 'pix' then
    return v_pix_enabled;
  end if;

  if v_method = 'credit_card_single' then
    return v_credit_single_enabled;
  end if;

  if v_method = 'credit_card_installments' then
    return v_credit_installments_enabled;
  end if;

  if v_method = 'credit_card' then
    return v_credit_single_enabled or v_credit_installments_enabled;
  end if;

  if v_method = 'courtesy' then
    return true;
  end if;

  return false;
end;
$$;

grant execute on function public.get_event_payment_methods_setup(uuid) to anon, authenticated;
grant execute on function public.upsert_event_payment_methods(uuid, boolean, boolean, boolean) to authenticated;
grant execute on function public.is_event_payment_method_allowed(uuid, text) to anon, authenticated;
