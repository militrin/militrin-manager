-- P0.1: emissao administrativa autorizava camiseta sem contrato canonico
-- (registration) ou com shirt_inventory.reserved/delivered legado (unassigned).
-- Reusa canonical_shirt_available_for_new_reservation (20261120): total fisico
-- de shirt_inventory, reserved/delivered do kit, pending nao contabilizado,
-- fail-safe sem linha kit = 0. Nao altera 20261120 nem migrations antigas.
-- Evento nao limitado: helper retorna sem bloquear.

begin;

create or replace function public.assert_canonical_shirt_stock_for_manual_issue(
  p_event_id uuid,
  p_shirt_type text,
  p_shirt_size text,
  p_quantity integer
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit boolean := false;
  v_has_shirt boolean := false;
  v_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_qty integer := greatest(coalesce(p_quantity, 0), 0);
  v_available integer := 0;
begin
  if p_event_id is null then
    return;
  end if;

  select coalesce(e.limit_shirt_selection_to_stock, false)
    into v_limit
  from public.events e
  where e.id = p_event_id;

  if not found or not v_limit then
    return;
  end if;

  select exists(
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active
  ) into v_has_shirt;

  if not v_has_shirt then
    return;
  end if;

  if v_type is null or v_size is null then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  if lower(v_type) = 'camiseta' then
    v_type := 'Camiseta';
  elsif lower(v_type) = 'babylook' then
    v_type := 'Babylook';
  else
    v_type := initcap(lower(v_type));
  end if;
  v_size := upper(v_size);

  if v_qty < 1 then
    return;
  end if;

  v_available := public.canonical_shirt_available_for_new_reservation(
    p_event_id, v_type, v_size, null
  );

  if v_available < v_qty then
    if v_available <= 0 then
      raise exception 'Sem estoque disponível para % %.', v_type, v_size;
    end if;
    if v_available = 1 then
      raise exception 'Há apenas 1 unidade disponível para % %.', v_type, v_size;
    end if;
    raise exception 'Há apenas % unidades disponíveis para % %.', v_available, v_type, v_size;
  end if;
end;
$$;

revoke all on function public.assert_canonical_shirt_stock_for_manual_issue(uuid, text, text, integer)
  from public, anon, authenticated;


create or replace function public.create_manual_registration_order(
  p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_full_name text,p_cpf text,p_birth_date date,p_gender text,
  p_phone text,p_email text,p_city text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null
) returns table(participant_id uuid,order_id uuid,order_item_id uuid,payment_id uuid,ticket_id uuid,full_name text,batch_name text,
  base_amount numeric,discount_amount numeric,final_amount numeric,payment_status text,reservation_expires_at timestamptz,shirt_type text,shirt_size text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_contact public.registration_contacts%rowtype; v_contact_result jsonb;
  v_participant public.participants%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype; v_payment public.payments%rowtype;
  v_batch public.registration_batches%rowtype;
  v_base numeric; v_batch_name text; v_ticket uuid;
  v_type text:=nullif(trim(coalesce(p_shirt_type,'')),''); v_size text:=nullif(trim(coalesce(p_shirt_size,'')),'');
  v_pricing_gender_key text:=lower(trim(coalesce(p_gender,'')));
  v_pricing_gender text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para criar inscricao manual.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;

  v_pricing_gender := case
    when v_pricing_gender_key in ('feminino','female','f') then 'female'
    when v_pricing_gender_key in ('masculino','male','m') then 'male'
    else null
  end;
  if v_pricing_gender is null then raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.'; end if;

  if p_ticket_category_id is not null then
    if not exists(select 1 from public.ticket_categories tc where tc.id=p_ticket_category_id and tc.event_id=p_event_id and tc.is_active) then
      raise exception 'Categoria invalida.';
    end if;
    select rb.name into v_batch_name from public.registration_batches rb where rb.id=p_batch_id and rb.event_id=p_event_id;
    if not found then raise exception 'Lote invalido.'; end if;
    select case when v_pricing_gender='female' then rbp.female_price else rbp.male_price end into v_base
      from public.registration_batch_prices rbp where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
    if v_base is null then raise exception 'Preco nao configurado.'; end if;
  else
    if exists(select 1 from public.ticket_categories where event_id=p_event_id and is_active=true) then
      raise exception 'Este evento usa categorias ativas; selecione uma categoria de acesso.';
    end if;
    select * into v_batch from public.registration_batches rb
    where rb.id=p_batch_id and rb.event_id=p_event_id
      and not exists(select 1 from public.registration_batch_prices rbp where rbp.batch_id=rb.id);
    if not found then raise exception 'Lote invalido para ingresso unico (sem categoria) neste evento.'; end if;
    v_batch_name := v_batch.name;
    v_base := case when v_pricing_gender='female' then v_batch.female_price else v_batch.male_price end;
  end if;

  if exists(select 1 from public.event_kit_items eki where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active) and (v_type is null or v_size is null) then
    raise exception 'Camiseta obrigatoria.';
  end if;

  perform public.assert_canonical_shirt_stock_for_manual_issue(p_event_id, v_type, v_size, 1);

  v_contact_result:=public.resolve_import_registration_contact(v_event.organization_id,null,p_full_name,p_cpf,p_birth_date,p_gender,p_phone,p_email,p_city);
  select * into strict v_contact from public.registration_contacts where id=(v_contact_result->>'registration_contact_id')::uuid for update;
  select * into v_participant from public.participants p where p.event_id=p_event_id and p.registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,full_name,cpf,birth_date,gender,phone,email,city,registration_status,reservation_status,notes)
    values(p_event_id,v_event.organization_id,v_contact.id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,v_contact.phone,v_contact.email,v_contact.city,
      'pending','pending',nullif(trim(coalesce(p_notes,'')),'')) returning * into v_participant;
  end if;

  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);
  insert into public.orders(user_id,participant_id,event_id,organization_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
    values(v_actor,v_participant.id,p_event_id,v_event.organization_id,public.generate_order_number(),'confirmed',v_base,v_base,0,'account',now()) returning * into v_order;

  perform set_config('app.manual_ticket_batch_override','true',true);

  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,ticket_category_id,batch_id,pricing_gender,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status) values(v_order.id,p_event_id,v_participant.id,v_contact.id,v_contact.id,'assigned',v_contact.full_name,p_ticket_category_id,p_batch_id,
    v_pricing_gender,v_type,v_size,1,v_base,v_base,0,'confirmed') returning * into v_item;

  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at)
    values(v_participant.id,p_event_id,v_event.organization_id,v_order.id,v_base,v_base,0,lower(trim(p_payment_method)),'paid',now()) returning * into v_payment;
  update public.orders set payment_id=v_payment.id where id=v_order.id;
  v_ticket:=public.confirm_order_item_and_issue_ticket(v_item.id);
  update public.tickets
  set intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
  where id = v_ticket;
  if v_contact.user_id is not null then
    perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
  end if;
  perform public.ensure_ticket_kit_items(v_ticket);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('manual_registration_order_created','orders',v_order.id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'registration_contact_id',v_contact.id,'participant_projection_id',v_participant.id,'order_item_id',v_item.id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,'payment_id',v_payment.id,'ticket_id',v_ticket,'category_owner','order_items',
      'intended_owner_contact_id',v_contact.id,'buyer_type',v_order.buyer_type));
  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket,v_contact.full_name,v_batch_name,v_base,v_base,0::numeric,
    v_payment.payment_status,null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end; $$;

create or replace function public.create_manual_unassigned_ticket_order("p_event_id" "uuid", "p_ticket_category_id" "uuid", "p_batch_id" "uuid", "p_pricing_gender" "text", "p_shirt_type" "text", "p_shirt_size" "text", "p_payment_method" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_item_id" "uuid", "payment_id" "uuid", "ticket_id" "uuid")
    language plpgsql security definer
    set search_path = public, pg_temp
    AS $$
declare
  v_actor uuid:=auth.uid();
  v_event public.events%rowtype;
  v_batch public.registration_batches%rowtype;
  v_base_amount numeric;
  v_pricing_gender_key text:=lower(trim(coalesce(p_pricing_gender,'')));
  v_pricing_gender text;
  v_order_id uuid;
  v_item_id uuid;
  v_payment_id uuid;
  v_ticket_id uuid;
  v_has_shirt_item boolean;
  v_shirt_type text;
  v_shirt_size text;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para emitir ingresso.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if p_batch_id is null then raise exception 'Lote obrigatorio.'; end if;

  v_pricing_gender := case
    when v_pricing_gender_key in ('feminino','female','f') then 'female'
    when v_pricing_gender_key in ('masculino','male','m') then 'male'
    else null
  end;
  if v_pricing_gender is null then
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if p_ticket_category_id is not null then
    if not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=p_event_id and is_active) then
      raise exception 'Categoria invalida para o evento.';
    end if;
    if not exists(select 1 from public.registration_batches where id=p_batch_id and event_id=p_event_id) then
      raise exception 'Lote nao pertence ao evento selecionado.';
    end if;

    select round((case when v_pricing_gender='female' then rbp.female_price else rbp.male_price end),2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
    if v_base_amount is null then
      raise exception 'Nao ha preco configurado para essa combinacao de categoria e lote.';
    end if;
  else
    if exists(select 1 from public.ticket_categories where event_id=p_event_id and is_active=true) then
      raise exception 'Este evento usa categorias ativas; selecione uma categoria de acesso.';
    end if;

    select * into v_batch from public.registration_batches rb
    where rb.id=p_batch_id and rb.event_id=p_event_id
      and not exists(select 1 from public.registration_batch_prices rbp where rbp.batch_id=rb.id);
    if not found then
      raise exception 'Lote invalido para ingresso unico (sem categoria) neste evento.';
    end if;
    v_base_amount := round((case when v_pricing_gender='female' then v_batch.female_price else v_batch.male_price end),2);
  end if;

  select exists(
    select 1 from public.event_kit_items eki
    where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active=true
  ) into v_has_shirt_item;
  if v_has_shirt_item then
    v_shirt_type := nullif(trim(coalesce(p_shirt_type,'')),'');
    v_shirt_size := nullif(trim(coalesce(p_shirt_size,'')),'');
    if v_shirt_type is null or v_shirt_size is null then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;
  else
    v_shirt_type := null;
    v_shirt_size := null;
  end if;

  -- Autorizacao canônica (20261120). Nao usa reserved/delivered legado.
  -- Antes de gerar pedido/numero: raise aqui nao consome sequencia.
  perform public.assert_canonical_shirt_stock_for_manual_issue(p_event_id, v_shirt_type, v_shirt_size, 1);

  insert into public.orders(user_id,participant_id,event_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,null,p_event_id,public.generate_order_number(),'confirmed',
    v_base_amount,v_base_amount,0,'account',now()) returning id into v_order_id;

  perform set_config('app.manual_ticket_batch_override','true',true);

  insert into public.order_items(order_id,event_id,participant_id,ownership_status,ticket_category_id,batch_id,pricing_gender,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at)
  values(v_order_id,p_event_id,null,'unassigned',p_ticket_category_id,p_batch_id,v_pricing_gender,v_shirt_type,v_shirt_size,
    1,v_base_amount,v_base_amount,0,
    'confirmed',null) returning id into v_item_id;

  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(null,p_event_id,v_event.organization_id,v_order_id,v_base_amount,v_base_amount,0,
    lower(trim(p_payment_method)),'paid',now(),null) returning id into v_payment_id;
  update public.orders set payment_id=v_payment_id where id=v_order_id;
  v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item_id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('manual_unassigned_ticket_order_created','orders',v_order_id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'order_item_id',v_item_id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,
      'payment_id',v_payment_id,'ticket_id',v_ticket_id,
      'reason',lower(trim(p_payment_method)),'notes',v_notes));

  return query select v_order_id,v_item_id,v_payment_id,v_ticket_id;
end;
$$;

create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid, p_event_id uuid, p_ticket_category_id uuid, p_batch_id uuid, p_quantity integer,
  p_pricing_gender text, p_shirt_type text, p_shirt_size text, p_payment_method text, p_notes text default null,
  p_assign_holder boolean default true,
  p_acknowledge_existing boolean default false,
  p_idempotency_key text default null
) returns table(ticket_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record;
  v_extra record;
  v_index integer;
  v_owner_user_id uuid;
  v_issue_reason text := lower(trim(coalesce(p_payment_method, '')));
  v_financial_method constant text := 'courtesy';
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_existing_ticket record;
  v_existing_code text;
  v_replay uuid[];
  v_issued uuid[] := '{}'::uuid[];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor::text || ':manual-issue:' || coalesce(p_registration_contact_id::text, '') || ':' || coalesce(p_event_id::text, ''),
    0
  ));
  if v_idempotency_key is not null then
    select ticket_ids into v_replay
    from public.manual_ticket_issue_requests
    where actor_user_id = v_actor
      and idempotency_key = v_idempotency_key;
    if found then
      foreach ticket_id in array coalesce(v_replay, '{}'::uuid[]) loop
        return next;
      end loop;
      return;
    end if;
  end if;
  if v_issue_reason not in ('courtesy', 'system_failure', 'administrative_correction', 'other') then
    raise exception 'Motivo de emissao manual invalido.';
  end if;
  if v_issue_reason = 'other' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Descreva o motivo da emissao manual.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Quantidade deve estar entre 1 e 20.';
  end if;
  select organization_id into v_event_organization_id from public.events where id = p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event_organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select * into v_contact from public.registration_contacts
  where id = p_registration_contact_id and organization_id = v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;
  select
    t.id,
    t.status,
    o.display_number,
    o.order_number,
    oi.item_position
  into v_existing_ticket
  from public.tickets t
  join public.order_items oi on oi.id = t.order_item_id
  join public.orders o on o.id = t.order_id
  where t.event_id = p_event_id
    and t.status in ('active', 'used')
    and (
      oi.registration_contact_id = v_contact.id
      or t.intended_owner_contact_id = v_contact.id
      or exists (
        select 1 from public.participants p
        where p.id = t.participant_id
          and p.registration_contact_id = v_contact.id
      )
    )
    and (p_ticket_category_id is null or oi.ticket_category_id is not distinct from p_ticket_category_id)
  order by t.issued_at desc nulls last, t.id desc
  limit 1;
  if found and coalesce(p_acknowledge_existing, false) is not true then
    v_existing_code := coalesce(
      '#' || lpad(coalesce(v_existing_ticket.display_number::text, '0'), 6, '0')
        || '-' || lpad(coalesce(v_existing_ticket.item_position::text, '1'), 2, '0'),
      v_existing_ticket.order_number
    );
    raise exception using errcode = 'P0001',
      message = 'EXISTING_OPERATIONAL_TICKET',
      detail = jsonb_build_object(
        'code', 'EXISTING_OPERATIONAL_TICKET',
        'ticket_id', v_existing_ticket.id,
        'ticket_status', v_existing_ticket.status,
        'ticket_code', v_existing_code,
        'message', format(
          'Esta pessoa já possui um ingresso ativo/usado para este evento. Ingresso existente: %s. Deseja realmente emitir outro ingresso?',
          v_existing_code
        )
      )::text;
  end if;

  -- Capacidade total do lote ANTES de materializar qualquer ingresso.
  -- A funcao inteira e uma transacao: falha na 3a unidade desfaz 1 e 2.
  perform public.assert_canonical_shirt_stock_for_manual_issue(
    p_event_id, p_shirt_type, p_shirt_size, p_quantity
  );

  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);
  perform set_config('app.administrative_intended_owner_contact_id', v_contact.id::text, true);

  if coalesce(p_assign_holder, true) then
    perform public.assert_ticket_holder_contact_available(null, p_event_id, v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id, p_ticket_category_id, p_batch_id, v_contact.full_name, v_contact.cpf, v_contact.birth_date,
      p_pricing_gender, v_contact.phone, v_contact.email, v_contact.city, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.participants
    set registration_contact_id = v_contact.id,
        user_id = case when user_id is null then v_contact.user_id else user_id end
    where id = v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items
    set registration_contact_id = v_contact.id,
        intended_owner_contact_id = v_contact.id
    where id = v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    update public.tickets
    set intended_owner_contact_id = v_contact.id
    where id = v_first.ticket_id;
    if v_contact.user_id is not null then
      perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
    end if;
    v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);
    update public.tickets
    set owner_user_id = v_owner_user_id
    where id = v_first.ticket_id
      and owner_user_id is null
      and v_owner_user_id is not null;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_first.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_first.ticket_id, v_first.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao administrativa para Pessoa com conta vinculada.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_first.ticket_id);
    perform public.assert_administrative_destination_ownership(v_first.ticket_id, v_contact.id);
    ticket_id := v_first.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_first.order_id,
      'order_item_id', v_first.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', true, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id, 'intended_owner_contact_id', v_contact.id));
    v_issued := array_append(v_issued, ticket_id);
    return next;
    v_index := 2;
  else
    v_index := 1;
  end if;

  v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id, p_ticket_category_id, p_batch_id, p_pricing_gender, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.order_items
    set intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_extra.order_item_id;
    update public.tickets
    set
      owner_user_id = coalesce(v_owner_user_id, owner_user_id),
      intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_extra.ticket_id;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_extra.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_extra.ticket_id, v_extra.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao sem titular para conta de destino.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_extra.ticket_id);
    perform public.assert_administrative_destination_ownership(v_extra.ticket_id, v_contact.id);
    ticket_id := v_extra.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_extra.order_id,
      'order_item_id', v_extra.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', false, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id, 'holder_assigned', false,
      'intended_owner_contact_id', v_contact.id));
    v_issued := array_append(v_issued, ticket_id);
    return next;
  end loop;
  if v_idempotency_key is not null then
    insert into public.manual_ticket_issue_requests(actor_user_id, idempotency_key, registration_contact_id, event_id, ticket_category_id, ticket_ids)
    values (v_actor, v_idempotency_key, v_contact.id, p_event_id, p_ticket_category_id, v_issued)
    on conflict (actor_user_id, idempotency_key) do nothing;
  end if;
end;
$$;

revoke all on function public.create_manual_registration_order(uuid, uuid, uuid, text, text, date, text, text, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_manual_registration_order(uuid, uuid, uuid, text, text, date, text, text, text, text, text, text, text, text)
  to authenticated, service_role;

revoke all on function public.create_manual_unassigned_ticket_order(uuid, uuid, uuid, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_manual_unassigned_ticket_order(uuid, uuid, uuid, text, text, text, text, text)
  to authenticated, service_role;

revoke all on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, text)
  to authenticated;

commit;
