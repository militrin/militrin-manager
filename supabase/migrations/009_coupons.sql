-- 009_coupons.sql
-- Sistema de cupons e cortesias por evento.

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  code text not null,
  coupon_type text not null,
  discount_percent numeric not null default 0,
  max_uses integer,
  used_count integer not null default 0,
  valid_from timestamptz,
  valid_until timestamptz,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_type_check check (coupon_type in ('courtesy', 'percentage')),
  constraint coupons_percent_check check (
    (coupon_type = 'courtesy' and discount_percent = 100)
    or (coupon_type = 'percentage' and discount_percent > 0 and discount_percent <= 100)
  ),
  constraint coupons_max_uses_check check (max_uses is null or max_uses > 0),
  constraint coupons_used_count_non_negative check (used_count >= 0),
  constraint coupons_used_count_limit check (max_uses is null or used_count <= max_uses)
);

create unique index if not exists ux_coupons_event_code on public.coupons (event_id, code);
create index if not exists idx_coupons_event_id on public.coupons (event_id);
create index if not exists idx_coupons_code on public.coupons (code);
create index if not exists idx_coupons_is_active on public.coupons (is_active);
create index if not exists idx_coupons_valid_until on public.coupons (valid_until);

create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id),
  participant_id uuid not null references public.participants(id),
  event_id uuid not null references public.events(id),
  original_amount numeric not null,
  discount_amount numeric not null,
  final_amount numeric not null,
  redeemed_at timestamptz not null default now(),
  constraint coupon_redemptions_amounts_check check (
    original_amount >= 0 and discount_amount >= 0 and final_amount >= 0
  )
);

create unique index if not exists ux_coupon_redemption_once_per_participant
on public.coupon_redemptions (coupon_id, participant_id);
create index if not exists idx_coupon_redemptions_event_id on public.coupon_redemptions (event_id);
create index if not exists idx_coupon_redemptions_coupon_id on public.coupon_redemptions (coupon_id);

create or replace function public.normalize_coupon_code()
returns trigger
language plpgsql
as $$
begin
  new.code := upper(trim(new.code));
  return new;
end;
$$;

drop trigger if exists trg_normalize_coupon_code on public.coupons;
create trigger trg_normalize_coupon_code
before insert or update of code on public.coupons
for each row execute function public.normalize_coupon_code();

alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;

drop policy if exists "coupons_read_only" on public.coupons;
create policy "coupons_read_only"
on public.coupons
for select
to anon, authenticated
using (true);

drop policy if exists "coupon_redemptions_read_only" on public.coupon_redemptions;
create policy "coupon_redemptions_read_only"
on public.coupon_redemptions
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.coupons from anon, authenticated;
revoke insert, update, delete on table public.coupon_redemptions from anon, authenticated;

grant select on table public.coupons to anon, authenticated;
grant select on table public.coupon_redemptions to anon, authenticated;

create or replace function public.validate_coupon(
  p_code text,
  p_event_id uuid,
  p_original_amount numeric
)
returns table (
  coupon_id uuid,
  coupon_type text,
  discount_percent numeric,
  discount_amount numeric,
  final_amount numeric,
  message text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_coupon public.coupons%rowtype;
  v_now timestamptz := now();
  v_discount numeric;
  v_final numeric;
begin
  v_code := upper(trim(coalesce(p_code, '')));

  if v_code = '' then
    raise exception 'Informe um codigo de cupom.';
  end if;

  if p_event_id is null then
    raise exception 'Evento invalido para validacao de cupom.';
  end if;

  if p_original_amount is null or p_original_amount < 0 then
    raise exception 'Valor original invalido.';
  end if;

  select * into v_coupon
  from public.coupons
  where event_id = p_event_id
    and code = v_code
  for update;

  if not found then
    raise exception 'Codigo invalido para este evento.';
  end if;

  if not v_coupon.is_active then
    raise exception 'Cupom inativo.';
  end if;

  if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then
    raise exception 'Cupom ainda nao esta vigente.';
  end if;

  if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then
    raise exception 'Cupom expirado.';
  end if;

  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
    raise exception 'Limite de usos do cupom atingido.';
  end if;

  if v_coupon.coupon_type = 'courtesy' then
    v_discount := round(p_original_amount, 2);
    v_final := 0;
  else
    v_discount := round((p_original_amount * v_coupon.discount_percent) / 100.0, 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  end if;

  return query
  select
    v_coupon.id,
    v_coupon.coupon_type,
    v_coupon.discount_percent,
    v_discount,
    v_final,
    case
      when v_coupon.coupon_type = 'courtesy' then 'Cortesia aplicada com sucesso.'
      else 'Cupom valido e pronto para aplicacao.'
    end;
end;
$$;

create or replace function public.redeem_coupon(
  p_coupon_id uuid,
  p_participant_id uuid,
  p_event_id uuid,
  p_original_amount numeric
)
returns table (
  discount_amount numeric,
  final_amount numeric,
  payment_status text,
  message text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coupon public.coupons%rowtype;
  v_participant public.participants%rowtype;
  v_discount numeric;
  v_final numeric;
  v_now timestamptz := now();
begin
  if p_coupon_id is null or p_participant_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes para resgate de cupom.';
  end if;

  if p_original_amount is null or p_original_amount < 0 then
    raise exception 'Valor original invalido para resgate.';
  end if;

  select * into v_coupon
  from public.coupons
  where id = p_coupon_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  if not v_coupon.is_active then
    raise exception 'Cupom inativo.';
  end if;

  if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then
    raise exception 'Cupom ainda nao esta vigente.';
  end if;

  if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then
    raise exception 'Cupom expirado.';
  end if;

  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
    raise exception 'Limite de usos do cupom atingido.';
  end if;

  if exists (
    select 1
    from public.coupon_redemptions
    where coupon_id = p_coupon_id
      and participant_id = p_participant_id
  ) then
    raise exception 'Este participante ja utilizou este cupom.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado para resgate do cupom.';
  end if;

  if v_coupon.coupon_type = 'courtesy' then
    v_discount := round(p_original_amount, 2);
    v_final := 0;
  else
    v_discount := round((p_original_amount * v_coupon.discount_percent) / 100.0, 2);
    v_final := round(greatest(0, p_original_amount - v_discount), 2);
  end if;

  update public.coupons
  set used_count = used_count + 1,
      updated_at = now()
  where id = p_coupon_id;

  insert into public.coupon_redemptions (
    coupon_id,
    participant_id,
    event_id,
    original_amount,
    discount_amount,
    final_amount
  ) values (
    p_coupon_id,
    p_participant_id,
    p_event_id,
    p_original_amount,
    v_discount,
    v_final
  );

  update public.participants
  set amount = v_final,
      payment_method = case when v_coupon.coupon_type = 'courtesy' then 'courtesy' else payment_method end,
      payment_status = case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
      reservation_status = case when v_coupon.coupon_type = 'courtesy' then 'confirmed' else reservation_status end,
      reservation_expires_at = case when v_coupon.coupon_type = 'courtesy' then null else reservation_expires_at end,
      updated_at = now()
  where id = p_participant_id;

  update public.payments
  set amount = v_final,
      payment_method = case when v_coupon.coupon_type = 'courtesy' then 'courtesy' else payment_method end,
      payment_status = case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
      paid_at = case when v_coupon.coupon_type = 'courtesy' then now() else paid_at end
  where participant_id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_redeemed',
    'participants',
    p_participant_id,
    jsonb_build_object(
      'coupon_id', p_coupon_id,
      'coupon_code', v_coupon.code,
      'coupon_type', v_coupon.coupon_type,
      'discount_percent', v_coupon.discount_percent,
      'original_amount', p_original_amount,
      'discount_amount', v_discount,
      'final_amount', v_final
    ),
    p_event_id
  );

  return query
  select
    v_discount,
    v_final,
    case when v_coupon.coupon_type = 'courtesy' then 'paid' else 'pending' end,
    case when v_coupon.coupon_type = 'courtesy' then 'Cortesia aplicada e pagamento confirmado.' else 'Cupom aplicado com sucesso.' end;
end;
$$;

create or replace function public.create_coupon(
  p_event_id uuid,
  p_code text,
  p_coupon_type text,
  p_discount_percent numeric,
  p_max_uses integer,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_notes text,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coupon_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_coupon_type text := lower(trim(coalesce(p_coupon_type, '')));
  v_discount numeric := coalesce(p_discount_percent, 0);
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio para criacao de cupom.';
  end if;

  if v_code = '' then
    raise exception 'Codigo do cupom obrigatorio.';
  end if;

  if v_coupon_type = 'courtesy' then
    v_discount := 100;
  elsif v_coupon_type = 'percentage' then
    if v_discount <= 0 or v_discount > 100 then
      raise exception 'Cupom percentual deve ter desconto maior que 0 e menor ou igual a 100.';
    end if;
  else
    raise exception 'Tipo de cupom invalido.';
  end if;

  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'Limite de usos deve ser maior que zero.';
  end if;

  insert into public.coupons (
    event_id,
    code,
    coupon_type,
    discount_percent,
    max_uses,
    valid_from,
    valid_until,
    notes,
    is_active
  ) values (
    p_event_id,
    v_code,
    v_coupon_type,
    v_discount,
    p_max_uses,
    p_valid_from,
    p_valid_until,
    nullif(trim(p_notes), ''),
    coalesce(p_is_active, true)
  ) returning id into v_coupon_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_created',
    'coupons',
    v_coupon_id,
    jsonb_build_object(
      'code', v_code,
      'coupon_type', v_coupon_type,
      'discount_percent', v_discount,
      'max_uses', p_max_uses
    ),
    p_event_id
  );

  return v_coupon_id;
end;
$$;

create or replace function public.update_coupon(
  p_coupon_id uuid,
  p_event_id uuid,
  p_code text,
  p_coupon_type text,
  p_discount_percent numeric,
  p_max_uses integer,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_notes text,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_coupon_type text := lower(trim(coalesce(p_coupon_type, '')));
  v_discount numeric := coalesce(p_discount_percent, 0);
begin
  if p_coupon_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  if v_code = '' then
    raise exception 'Codigo do cupom obrigatorio.';
  end if;

  if v_coupon_type = 'courtesy' then
    v_discount := 100;
  elsif v_coupon_type = 'percentage' then
    if v_discount <= 0 or v_discount > 100 then
      raise exception 'Cupom percentual deve ter desconto maior que 0 e menor ou igual a 100.';
    end if;
  else
    raise exception 'Tipo de cupom invalido.';
  end if;

  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'Limite de usos deve ser maior que zero.';
  end if;

  update public.coupons
  set
    code = v_code,
    coupon_type = v_coupon_type,
    discount_percent = v_discount,
    max_uses = p_max_uses,
    valid_from = p_valid_from,
    valid_until = p_valid_until,
    notes = nullif(trim(p_notes), ''),
    is_active = coalesce(p_is_active, true),
    updated_at = now()
  where id = p_coupon_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_updated',
    'coupons',
    p_coupon_id,
    jsonb_build_object(
      'code', v_code,
      'coupon_type', v_coupon_type,
      'discount_percent', v_discount,
      'max_uses', p_max_uses,
      'is_active', coalesce(p_is_active, true)
    ),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.toggle_coupon_active(
  p_coupon_id uuid,
  p_event_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_coupon_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  update public.coupons
  set is_active = coalesce(p_is_active, false),
      updated_at = now()
  where id = p_coupon_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Cupom nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'coupon_toggled',
    'coupons',
    p_coupon_id,
    jsonb_build_object('is_active', coalesce(p_is_active, false)),
    p_event_id
  );

  return true;
end;
$$;

revoke all on function public.validate_coupon(text, uuid, numeric) from public, anon, authenticated;
revoke all on function public.redeem_coupon(uuid, uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.create_coupon(uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.update_coupon(uuid, uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.toggle_coupon_active(uuid, uuid, boolean) from public, anon, authenticated;

grant execute on function public.validate_coupon(text, uuid, numeric) to anon;
grant execute on function public.validate_coupon(text, uuid, numeric) to authenticated;
grant execute on function public.redeem_coupon(uuid, uuid, uuid, numeric) to anon;
grant execute on function public.redeem_coupon(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function public.create_coupon(uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) to anon;
grant execute on function public.create_coupon(uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) to authenticated;
grant execute on function public.update_coupon(uuid, uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) to anon;
grant execute on function public.update_coupon(uuid, uuid, text, text, numeric, integer, timestamptz, timestamptz, text, boolean) to authenticated;
grant execute on function public.toggle_coupon_active(uuid, uuid, boolean) to anon;
grant execute on function public.toggle_coupon_active(uuid, uuid, boolean) to authenticated;
