-- 008_temporary_reservations.sql
-- Reserva temporaria de camiseta para inscricoes com pagamento pendente.

alter table public.participants
  add column if not exists reservation_status text not null default 'pending',
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists reservation_released_at timestamptz;

alter table public.participants
  drop constraint if exists participants_reservation_status_check;

alter table public.participants
  add constraint participants_reservation_status_check
  check (reservation_status in ('pending', 'confirmed', 'expired', 'released'));

create index if not exists idx_participants_reservation_status on public.participants (reservation_status);
create index if not exists idx_participants_reservation_expires_at on public.participants (reservation_expires_at);
create index if not exists idx_participants_event_id_reservation on public.participants (event_id);

alter table public.payments
  add column if not exists paid_at timestamptz;

create or replace function public.create_registration(
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_email text,
  p_city text,
  p_shirt_type text,
  p_shirt_size text,
  p_registration_status text,
  p_notes text,
  p_amount numeric,
  p_payment_method text,
  p_payment_status text,
  p_event_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
  v_payment_status text := coalesce(p_payment_status, 'pending');
  v_reservation_status text;
  v_reservation_expires_at timestamptz;
begin
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if exists (
    select 1
    from public.participants
    where cpf = p_cpf and event_id = v_event_id
  ) then
    raise exception 'CPF ja cadastrado para o evento ativo.';
  end if;

  select (total_quantity - reserved_quantity - delivered_quantity)
  into v_available_stock
  from public.shirt_inventory
  where event_id = v_event_id
    and shirt_type = p_shirt_type
    and shirt_size = p_shirt_size
  for update;

  if not found then
    raise exception 'Estoque nao encontrado para este modelo e tamanho.';
  end if;

  if v_available_stock <= 0 then
    raise exception 'Estoque indisponivel para este modelo e tamanho.';
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity + 1,
      updated_at = now()
  where event_id = v_event_id
    and shirt_type = p_shirt_type
    and shirt_size = p_shirt_size;

  if v_payment_status = 'paid' then
    v_reservation_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_reservation_status := 'pending';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  insert into public.participants (
    event_id,
    full_name,
    cpf,
    birth_date,
    gender,
    phone,
    email,
    city,
    shirt_type,
    shirt_size,
    registration_status,
    amount,
    notes,
    reservation_status,
    reservation_expires_at,
    reservation_released_at
  ) values (
    v_event_id,
    p_full_name,
    p_cpf,
    p_birth_date,
    p_gender,
    p_phone,
    p_email,
    p_city,
    p_shirt_type,
    p_shirt_size,
    coalesce(p_registration_status, 'pending'),
    coalesce(p_amount, 0),
    p_notes,
    v_reservation_status,
    v_reservation_expires_at,
    null
  ) returning id into v_participant_id;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    payment_method,
    payment_status,
    paid_at
  ) values (
    v_participant_id,
    v_event_id,
    coalesce(p_amount, 0),
    p_payment_method,
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_created',
    'participants',
    v_participant_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'payment_status', v_payment_status,
      'reservation_status', v_reservation_status,
      'reservation_expires_at', v_reservation_expires_at
    ),
    v_event_id
  );

  return v_participant_id;
end;
$$;

create or replace function public.confirm_registration_payment(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_available integer;
  v_re_reserved boolean := false;
begin
  if p_participant_id is null then
    raise exception 'ID do participante e obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if v_participant.payment_status = 'paid'
     and v_participant.reservation_status = 'confirmed' then
    return true;
  end if;

  if v_participant.reservation_status in ('expired', 'released') then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para o modelo/tamanho do participante.';
    end if;

    v_available := v_inventory.total_quantity - v_inventory.reserved_quantity - v_inventory.delivered_quantity;
    if v_available <= 0 then
      raise exception 'Reserva expirada e sem estoque disponivel para reativar. Revisao manual necessaria.';
    end if;

    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + 1,
        updated_at = now()
    where id = v_inventory.id;

    v_re_reserved := true;
  end if;

  update public.participants
  set payment_status = 'paid',
      reservation_status = 'confirmed',
      reservation_expires_at = null,
      reservation_released_at = null,
      updated_at = now()
  where id = p_participant_id;

  update public.payments
  set payment_status = 'paid',
      paid_at = now()
  where participant_id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_payment_confirmed',
    'participants',
    p_participant_id,
    jsonb_build_object(
      're_reserved', v_re_reserved,
      'shirt_type', v_participant.shirt_type,
      'shirt_size', v_participant.shirt_size
    ),
    v_participant.event_id
  );

  return true;
end;
$$;

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_released_count integer := 0;
begin
  for v_participant in
    select *
    from public.participants
    where reservation_status = 'pending'
      and reservation_expires_at is not null
      and reservation_expires_at <= now()
      and payment_status = 'pending'
    for update skip locked
  loop
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;
    end if;

    update public.participants
    set reservation_status = 'expired',
        reservation_released_at = now(),
        reservation_expires_at = null,
        updated_at = now()
    where id = v_participant.id
      and reservation_status = 'pending';

    if found then
      v_released_count := v_released_count + 1;

      insert into public.audit_logs (
        action,
        entity_type,
        entity_id,
        details,
        event_id
      ) values (
        'reservation_expired_released',
        'participants',
        v_participant.id,
        jsonb_build_object(
          'shirt_type', v_participant.shirt_type,
          'shirt_size', v_participant.shirt_size,
          'reservation_expires_at', v_participant.reservation_expires_at
        ),
        v_participant.event_id
      );
    end if;
  end loop;

  return v_released_count;
end;
$$;

revoke all on function public.confirm_registration_payment(uuid) from public, anon, authenticated;
revoke all on function public.release_expired_reservations() from public, anon, authenticated;

grant execute on function public.confirm_registration_payment(uuid) to anon;
grant execute on function public.confirm_registration_payment(uuid) to authenticated;
grant execute on function public.release_expired_reservations() to anon;
grant execute on function public.release_expired_reservations() to authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception
      when others then
        null;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'release_expired_reservations_every_5m';

    perform cron.schedule(
      'release_expired_reservations_every_5m',
      '*/5 * * * *',
      'select public.release_expired_reservations();'
    );
  end if;
end;
$$;
