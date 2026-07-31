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
as $$
declare
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
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
    raise exception 'CPF já cadastrado para o evento ativo.';
  end if;

  select (total_quantity - reserved_quantity - delivered_quantity)
  into v_available_stock
  from public.shirt_inventory
  where event_id = v_event_id
    and shirt_type = p_shirt_type
    and shirt_size = p_shirt_size
  for update;

  if not found then
    raise exception 'Estoque não encontrado para este modelo e tamanho.';
  end if;

  if v_available_stock <= 0 then
    raise exception 'Estoque indisponível para este modelo e tamanho.';
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity + 1,
      updated_at = now()
  where event_id = v_event_id
    and shirt_type = p_shirt_type
    and shirt_size = p_shirt_size;

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
    notes
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
    p_notes
  ) returning id into v_participant_id;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    payment_method,
    payment_status
  ) values (
    v_participant_id,
    v_event_id,
    coalesce(p_amount, 0),
    p_payment_method,
    coalesce(p_payment_status, 'pending')
  );

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'system',
    'registration_created',
    'participants',
    v_participant_id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'payment_status', coalesce(p_payment_status, 'pending')
    )
  );

  return v_participant_id;
end;
$$;

create or replace function public.deliver_kit(p_participant_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_participant public.participants%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_event_id uuid;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante não encontrado.';
  end if;

  v_event_id := v_participant.event_id;
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Evento não encontrado.';
  end if;

  select * into v_inventory
  from public.shirt_inventory
  where event_id = v_event_id
    and shirt_type = v_participant.shirt_type
    and shirt_size = v_participant.shirt_size
  for update;

  if not found then
    raise exception 'Estoque não encontrado para a camiseta do participante.';
  end if;

  if v_inventory.reserved_quantity <= 0 then
    raise exception 'A camiseta não está reservada para este participante.';
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity - 1,
      delivered_quantity = delivered_quantity + 1,
      updated_at = now()
  where id = v_inventory.id;

  insert into public.kit_deliveries (
    participant_id,
    event_id,
    shirt_type,
    shirt_size
  ) values (
    v_participant.id,
    v_event_id,
    v_participant.shirt_type,
    v_participant.shirt_size
  );

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'system',
    'kit_delivered',
    'participants',
    v_participant.id,
    v_event_id,
    jsonb_build_object(
      'shirt_type', v_participant.shirt_type,
      'shirt_size', v_participant.shirt_size
    )
  );

  return true;
end;
$$;

alter table public.participants enable row level security;
alter table public.payments enable row level security;
alter table public.shirt_inventory enable row level security;
alter table public.kit_deliveries enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Authenticated users can read participants" on public.participants;
create policy "Authenticated users can read participants"
on public.participants
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert participants" on public.participants;
create policy "Authenticated users can insert participants"
on public.participants
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update participants" on public.participants;
create policy "Authenticated users can update participants"
on public.participants
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete participants" on public.participants;
create policy "Authenticated users can delete participants"
on public.participants
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read payments" on public.payments;
create policy "Authenticated users can read payments"
on public.payments
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert payments" on public.payments;
create policy "Authenticated users can insert payments"
on public.payments
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update payments" on public.payments;
create policy "Authenticated users can update payments"
on public.payments
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete payments" on public.payments;
create policy "Authenticated users can delete payments"
on public.payments
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can read shirt inventory"
on public.shirt_inventory
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can insert shirt inventory"
on public.shirt_inventory
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can update shirt inventory"
on public.shirt_inventory
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can delete shirt inventory"
on public.shirt_inventory
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can read kit deliveries"
on public.kit_deliveries
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can insert kit deliveries"
on public.kit_deliveries
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can update kit deliveries"
on public.kit_deliveries
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can delete kit deliveries"
on public.kit_deliveries
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read audit logs" on public.audit_logs;
create policy "Authenticated users can read audit logs"
on public.audit_logs
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert audit logs" on public.audit_logs;
create policy "Authenticated users can insert audit logs"
on public.audit_logs
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update audit logs" on public.audit_logs;
create policy "Authenticated users can update audit logs"
on public.audit_logs
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete audit logs" on public.audit_logs;
create policy "Authenticated users can delete audit logs"
on public.audit_logs
for delete to authenticated using (true);
