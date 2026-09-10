-- P0 ownership cycle: destinatario conhecido nunca perde intended_owner.
-- Owner so materializa quando registration_contacts.user_id existe (Auth vinculada).
-- Nao preenche owner de Pessoa sem primeiro acesso. Nao casa por e-mail/CPF.
-- Nao altera QR, pagamento, Loja, Roberto, Leonardo, Jordan.

begin;

create or replace function public.assert_administrative_destination_ownership(
  p_ticket_id uuid,
  p_destination_contact_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
begin
  if p_ticket_id is null or p_destination_contact_id is null then
    raise exception 'ADMINISTRATIVE_TICKET_REQUIRES_INTENDED_OWNER: destinatario conhecido e obrigatorio.';
  end if;
  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then
    raise exception 'ADMINISTRATIVE_TICKET_REQUIRES_INTENDED_OWNER: ingresso nao encontrado.';
  end if;
  if v_ticket.intended_owner_contact_id is distinct from p_destination_contact_id then
    raise exception 'ADMINISTRATIVE_TICKET_REQUIRES_INTENDED_OWNER: destinatario conhecido exige intended_owner_contact_id.';
  end if;
  if v_ticket.owner_user_id is null and v_ticket.intended_owner_contact_id is null then
    raise exception 'ADMINISTRATIVE_TICKET_OWNERSHIP_INCOMPLETE: owner e intended_owner nulos com destinatario conhecido.';
  end if;
end;
$$;

revoke all on function public.assert_administrative_destination_ownership(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assert_administrative_destination_ownership(uuid, uuid) to service_role;

create or replace function public.trg_initialize_ticket_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_holder public.participants%rowtype;
  v_registration_contact_id uuid;
  v_import_batch_ids uuid[] := array[]::uuid[];
  v_imported_by_user_ids uuid[] := array[]::uuid[];
  v_is_imported boolean := false;
begin
  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is null then
    new.organization_id := v_order.organization_id;
  elsif new.organization_id is distinct from v_order.organization_id then
    raise exception 'Organizacao do ingresso diverge do pedido.';
  end if;

  if new.order_item_id is not null then
    select * into v_item from public.order_items where id = new.order_item_id;
  end if;
  if coalesce(v_item.participant_id, new.participant_id) is not null then
    select * into v_holder from public.participants where id = coalesce(v_item.participant_id, new.participant_id);
  end if;
  v_registration_contact_id := coalesce(v_item.registration_contact_id, v_holder.registration_contact_id);

  if new.intended_owner_contact_id is null then
    new.intended_owner_contact_id := v_item.intended_owner_contact_id;
  end if;
  if new.intended_owner_contact_id is null
     and v_order.buyer_type in ('administrative', 'imported_holder') then
    new.intended_owner_contact_id := v_registration_contact_id;
  end if;

  select coalesce(array_agg(distinct ib.id order by ib.id), array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by) filter (where ib.imported_by is not null), array[]::uuid[])
  into v_import_batch_ids, v_imported_by_user_ids
  from public.import_batches ib
  where ib.id = v_order.import_batch_id or exists (
    select 1 from public.participation_history ph
    where ph.import_batch_id = ib.id and ph.source = 'import'
      and ph.participant_id in (v_order.participant_id, coalesce(v_item.participant_id, new.participant_id))
  );
  v_is_imported := v_order.buyer_type = 'imported_holder' or cardinality(v_import_batch_ids) > 0;

  if v_is_imported then
    new.owner_user_id := public.resolve_administrative_ticket_owner(new.organization_id, v_registration_contact_id);
    if new.owner_user_id is not null and new.owner_user_id = any (v_imported_by_user_ids) then
      new.owner_user_id := null;
    end if;
    return new;
  end if;

  if v_order.buyer_type = 'administrative' then
    new.owner_user_id := public.resolve_administrative_ticket_owner(new.organization_id, v_registration_contact_id);
    return new;
  end if;
  if new.owner_user_id is not null then return new; end if;
  if v_order.buyer_type = 'account' then
    if v_order.user_id is null or not exists (select 1 from auth.users where id = v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id := v_order.user_id;
  else
    raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end;
$$;

create or replace function public.trg_materialize_linked_ticket_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid := new.intended_owner_contact_id;
  v_user_id uuid;
  v_assigned integer := 0;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if v_contact_id is null then return new; end if;

  select c.user_id into v_user_id
  from public.registration_contacts c
  join auth.users au on au.id = c.user_id
  where c.id = v_contact_id;

  if v_user_id is null then
    return new;
  end if;

  if new.participant_id is not null then
    update public.participants p
    set user_id = v_user_id, updated_at = now()
    where p.id = new.participant_id
      and p.user_id is null
      and p.registration_contact_id = v_contact_id;
  end if;

  v_assigned := public.materialize_intended_ticket_owners_for_contact(v_contact_id, v_user_id);

  if v_assigned = 0 and new.owner_user_id is not distinct from v_user_id
    and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = new.id
    ) then
    insert into public.ticket_owner_history (
      ticket_id, order_id, event_id, organization_id, operation,
      previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
    )
    values (
      new.id, new.order_id, new.event_id, new.organization_id, 'owner_assigned',
      null, v_user_id, v_user_id, 'data_regularization',
      'Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_materialize_linked_ticket_owner on public.tickets;
create trigger trg_materialize_linked_ticket_owner
after insert or update of intended_owner_contact_id
on public.tickets
for each row execute function public.trg_materialize_linked_ticket_owner();

create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid, p_event_id uuid, p_ticket_category_id uuid, p_batch_id uuid, p_quantity integer,
  p_pricing_gender text, p_shirt_type text, p_shirt_size text, p_payment_method text, p_notes text default null,
  p_assign_holder boolean default true
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
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
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
  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);

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
    set intended_owner_contact_id = v_contact.id
    where id = v_extra.order_item_id
      and participant_id is null
      and coalesce(ownership_status, 'unassigned') = 'unassigned';
    update public.tickets
    set
      owner_user_id = v_owner_user_id,
      intended_owner_contact_id = v_contact.id
    where id = v_extra.ticket_id
      and participant_id is null;
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
    return next;
  end loop;
end;
$$;

revoke all on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  to authenticated;

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

  v_contact_result:=public.resolve_import_registration_contact(v_event.organization_id,null,p_full_name,p_cpf,p_birth_date,p_gender,p_phone,p_email,p_city);
  select * into strict v_contact from public.registration_contacts where id=(v_contact_result->>'registration_contact_id')::uuid for update;
  select * into v_participant from public.participants p where p.event_id=p_event_id and p.registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,full_name,cpf,birth_date,gender,phone,email,city,registration_status,reservation_status,notes)
    values(p_event_id,v_event.organization_id,v_contact.id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,v_contact.phone,v_contact.email,v_contact.city,
      'pending','pending',nullif(trim(coalesce(p_notes,'')),'')) returning * into v_participant;
  end if;

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
      'intended_owner_contact_id',v_contact.id));
  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket,v_contact.full_name,v_batch_name,v_base,v_base,0::numeric,
    v_payment.payment_status,null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end; $$;

commit;
