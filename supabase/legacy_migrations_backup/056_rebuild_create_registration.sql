-- 056_rebuild_create_registration.sql
-- Reconstroi a funcao principal de inscricao e elimina ambiguidades de colunas.
-- Tambem respeita o modo "livre para encomenda" e usa constraint explicita nos itens de kit.

begin;

-- Garante unicidade para o upsert dos itens de kit.
-- Mantem um unico registro por participante + item de kit.
delete from public.participant_kit_items a
using public.participant_kit_items b
where a.participant_id = b.participant_id
  and a.kit_item_id = b.kit_item_id
  and a.ctid > b.ctid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.participant_kit_items'::regclass
      and conname = 'participant_kit_items_participant_kit_unique'
  ) then
    alter table public.participant_kit_items
      add constraint participant_kit_items_participant_kit_unique
      unique (participant_id, kit_item_id);
  end if;
end;
$$;

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
  p_payment_method text,
  p_payment_status text,
  p_event_id uuid,
  p_coupon_code text default null,
  p_ticket_category_id uuid default null
)
returns table(
  participant_id uuid,
  full_name text,
  batch_name text,
  base_amount numeric,
  discount_amount numeric,
  final_amount numeric,
  payment_status text,
  reservation_expires_at timestamptz,
  shirt_type text,
  shirt_size text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
  v_event public.events%rowtype;
  v_payment_status text := coalesce(nullif(trim(p_payment_status), ''), 'pending');
  v_payment_method text := coalesce(nullif(trim(p_payment_method), ''), 'pix');
  v_reservation_status text;
  v_reservation_expires_at timestamptz;
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base_amount numeric;
  v_discount_amount numeric := 0;
  v_final_amount numeric;
  v_coupon record;
  v_coupon_type text;
  v_ticket_category_id uuid;
  v_ticket_category_capacity integer;
  v_category_reserved_count integer;
  v_has_shirt_item boolean := false;
  v_enforce_physical_stock boolean := false;
  v_shirt_type text;
  v_shirt_size text;
  v_kit_item public.event_kit_items%rowtype;
begin
  if v_event_id is null then
    select e.id
      into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select e.*
    into v_event
  from public.events e
  where e.id = v_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = v_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
  )
  into v_has_shirt_item;

  select p.id
    into v_participant_id
  from public.participants p
  where p.cpf = p_cpf
    and p.event_id = v_event_id
  order by p.created_at asc
  limit 1
  for update;

  if p_ticket_category_id is not null then
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.id = p_ticket_category_id
      and tc.event_id = v_event_id
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      raise exception 'Categoria de acesso invalida para o evento ativo.';
    end if;
  else
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.event_id = v_event_id
      and tc.slug = 'open-bar'
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      select tc.id, tc.capacity
        into v_ticket_category_id, v_ticket_category_capacity
      from public.ticket_categories tc
      where tc.event_id = v_event_id
        and tc.is_active = true
      order by tc.sort_order asc, tc.name asc
      limit 1;
    end if;
  end if;

  if v_ticket_category_id is null then
    raise exception 'Nenhuma categoria de acesso ativa para o evento.';
  end if;

  select count(*)::integer
    into v_category_reserved_count
  from public.participants p
  where p.event_id = v_event_id
    and p.ticket_category_id = v_ticket_category_id
    and coalesce(p.registration_status, 'pending') <> 'cancelled'
    and p.reservation_status in ('pending', 'confirmed');

  if v_ticket_category_capacity is not null
     and v_category_reserved_count >= v_ticket_category_capacity then
    raise exception 'Capacidade da categoria de acesso atingida.';
  end if;

  v_shirt_type := coalesce(nullif(trim(p_shirt_type), ''), 'Sem camiseta');
  v_shirt_size := coalesce(nullif(trim(p_shirt_size), ''), 'N/A');

  if v_has_shirt_item then
    if coalesce(trim(p_shirt_type), '') = ''
       or coalesce(trim(p_shirt_size), '') = '' then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;

    if v_enforce_physical_stock then
      select si.*
        into v_inventory
      from public.shirt_inventory si
      where si.event_id = v_event_id
        and si.shirt_type = v_shirt_type
        and si.shirt_size = v_shirt_size
      for update;

      if not found then
        raise exception 'Estoque nao encontrado para este modelo e tamanho.';
      end if;

      v_available_stock :=
        coalesce(v_inventory.total_quantity, 0)
        - coalesce(v_inventory.reserved_quantity, 0)
        - coalesce(v_inventory.delivered_quantity, 0);

      if v_available_stock <= 0 then
        raise exception 'Estoque indisponivel para este modelo e tamanho.';
      end if;
    end if;
  end if;

  select rb.*
    into v_batch
  from public.registration_batches rb
  where rb.event_id = v_event_id
    and rb.is_active = true
  order by rb.sequence_number asc
  limit 1
  for update;

  if not found then
    raise exception 'Inscricoes encerradas ou lotes esgotados.';
  end if;

  select count(*)::integer
    into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if v_confirmed_count >= v_batch.max_confirmed_registrations then
    perform *
    from public.advance_registration_batch_if_needed(v_event_id);

    select rb.*
      into v_batch
    from public.registration_batches rb
    where rb.event_id = v_event_id
      and rb.is_active = true
    order by rb.sequence_number asc
    limit 1
    for update;

    if not found then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if v_base_amount is null then
    raise exception 'Preco nao configurado para esta categoria e lote.';
  end if;

  v_final_amount := v_base_amount;

  if lower(v_payment_method) = 'courtesy' then
    v_payment_status := 'paid';
    v_payment_method := 'courtesy';
  end if;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select vc.*
      into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base_amount) vc
    limit 1;

    v_coupon_type := v_coupon.coupon_type;
    v_discount_amount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final_amount := round(coalesce(v_coupon.final_amount, v_base_amount), 2);

    if coalesce(v_coupon_type, '') = 'courtesy' then
      v_payment_status := 'paid';
      v_payment_method := 'courtesy';
    end if;
  end if;

  if v_has_shirt_item and v_enforce_physical_stock then
    update public.shirt_inventory si
    set reserved_quantity = coalesce(si.reserved_quantity, 0) + 1,
        updated_at = now()
    where si.id = v_inventory.id;

    insert into public.inventory_movements (
      event_id,
      inventory_id,
      movement_type,
      quantity,
      notes
    ) values (
      v_event_id,
      v_inventory.id,
      'adjustment',
      -1,
      format('Reserva de inscricao %s (%s).', p_full_name, p_cpf)
    );
  end if;

  if v_payment_status = 'paid' then
    v_reservation_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_reservation_status := 'pending';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  if v_participant_id is null then
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
      notes,
      reservation_status,
      reservation_expires_at,
      reservation_released_at,
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id
    ) values (
      v_event_id,
      p_full_name,
      p_cpf,
      p_birth_date,
      p_gender,
      p_phone,
      p_email,
      p_city,
      v_shirt_type,
      v_shirt_size,
      coalesce(
        nullif(trim(p_registration_status), ''),
        case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
      ),
      p_notes,
      v_reservation_status,
      v_reservation_expires_at,
      null,
      v_batch.id,
      v_base_amount,
      v_discount_amount,
      v_final_amount,
      v_ticket_category_id
    )
    returning public.participants.id into v_participant_id;
  else
    update public.participants p
    set full_name = p_full_name,
        cpf = p_cpf,
        birth_date = p_birth_date,
        gender = p_gender,
        phone = p_phone,
        email = p_email,
        city = p_city,
        shirt_type = v_shirt_type,
        shirt_size = v_shirt_size,
        registration_status = coalesce(
          nullif(trim(p_registration_status), ''),
          case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
        ),
        notes = p_notes,
        reservation_status = v_reservation_status,
        reservation_expires_at = v_reservation_expires_at,
        reservation_released_at = null,
        batch_id = v_batch.id,
        base_amount = v_base_amount,
        discount_amount = v_discount_amount,
        final_amount = v_final_amount,
        ticket_category_id = v_ticket_category_id,
        updated_at = now()
    where p.id = v_participant_id;
  end if;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    discount_amount,
    final_amount,
    payment_method,
    payment_status,
    paid_at,
    expires_at
  ) values (
    v_participant_id,
    v_event_id,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_method,
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    case when v_payment_status = 'paid' then null else v_reservation_expires_at end
  );

  if coalesce(v_event.kit_enabled, false) then
    for v_kit_item in
      select eki.*
      from public.event_kit_items eki
      where eki.event_id = v_event_id
        and eki.is_active = true
      order by eki.sort_order asc, eki.created_at asc
    loop
      insert into public.participant_kit_items (
        participant_id,
        event_id,
        kit_item_id,
        variant_data,
        quantity,
        status
      ) values (
        v_participant_id,
        v_event_id,
        v_kit_item.id,
        case
          when v_kit_item.item_type = 'shirt'
            then jsonb_build_object(
              'shirt_type', v_shirt_type,
              'shirt_size', v_shirt_size
            )
          else null
        end,
        v_kit_item.quantity_per_participant,
        case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
      )
      on conflict on constraint participant_kit_items_participant_kit_unique
      do update set
        event_id = excluded.event_id,
        quantity = excluded.quantity,
        status = excluded.status,
        variant_data = excluded.variant_data;
    end loop;
  end if;

  return query
  select
    v_participant_id,
    p_full_name,
    v_batch.name,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_status,
    v_reservation_expires_at,
    v_shirt_type,
    v_shirt_size;
end;
$function$;

grant execute on function public.create_registration(
  text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid
) to authenticated;

grant execute on function public.create_registration(
  text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid
) to anon;

commit;