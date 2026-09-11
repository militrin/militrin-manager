-- Nova inscricao administrativa (/inscricoes/nova) reusa o GUC
-- app.administrative_ticket_issue_actor ja usado por issue_manual_ticket_batch.
-- O trigger trg_classify_administrative_order reescreve o insert para
-- buyer_type='administrative', user_id=null, import_batch_id=null.
-- Sem backfill: pedidos historicos de create_manual_registration_order
-- permanecem com a classificacao original.

begin;

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

commit;
