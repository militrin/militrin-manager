-- Importacao legada com preco historico desconhecido.
-- amount 0 + price_origin='legacy_unknown' e placeholder NOT NULL, nunca
-- cortesia, nunca gratuito, nunca preco atual do lote, nunca receita Asaas.
begin;

alter table public.orders
  add column if not exists price_origin text;
alter table public.order_items
  add column if not exists price_origin text;
alter table public.payments
  add column if not exists price_origin text;

alter table public.orders drop constraint if exists orders_price_origin_check;
alter table public.orders add constraint orders_price_origin_check
  check (price_origin is null or price_origin in ('catalog','legacy_unknown','legacy_provided'));
alter table public.order_items drop constraint if exists order_items_price_origin_check;
alter table public.order_items add constraint order_items_price_origin_check
  check (price_origin is null or price_origin in ('catalog','legacy_unknown','legacy_provided'));
alter table public.payments drop constraint if exists payments_price_origin_check;
alter table public.payments add constraint payments_price_origin_check
  check (price_origin is null or price_origin in ('catalog','legacy_unknown','legacy_provided'));

create or replace function public.is_legacy_import_unknown_price(
  p_price_origin text, p_buyer_type text, p_import_batch_id uuid
) returns boolean language sql immutable as $$
  select coalesce(p_price_origin,'') = 'legacy_unknown'
    and coalesce(p_buyer_type,'') = 'imported_holder'
    and p_import_batch_id is not null;
$$;

create or replace function public.is_legacy_import_historical_price(p_price_origin text)
returns boolean language sql immutable as $$
  select coalesce(p_price_origin,'') in ('legacy_unknown','legacy_provided');
$$;

-- Checkout nativo continua exigindo pagamento pago. Importacao com
-- preco historico desconhecido emite o ingresso operacional sem gravar
-- payments.payment_status='paid' (sem evidencia financeira).
create or replace function public.confirm_order_item_and_issue_ticket(p_order_item_id uuid) returns uuid
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_event public.events%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
  v_ticket_status text;
  v_ticket_inserted boolean;
  v_legacy_unknown boolean;
begin
  if p_order_item_id is null then raise exception 'Item do pedido obrigatorio.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado para o item.'; end if;
  select * into v_event from public.events where id=v_item.event_id for share;
  if not found then raise exception 'Evento nao encontrado para o item.'; end if;

  if v_order.event_id is distinct from v_event.id then
    raise exception 'Evento do item diverge do evento do pedido.';
  end if;
  if v_order.organization_id is distinct from v_event.organization_id then
    raise exception 'Organizacao do pedido diverge da organizacao do evento.';
  end if;
  if v_item.participant_id is not null and exists(
    select 1 from public.participants p
    where p.id=v_item.participant_id and p.organization_id is distinct from v_event.organization_id
  ) then
    raise exception 'Organizacao do titular diverge da organizacao do evento.';
  end if;

  select * into v_payment from public.payments where order_id=v_order.id
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;
  v_legacy_unknown := public.is_legacy_import_unknown_price(v_order.price_origin, v_order.buyer_type, v_order.import_batch_id);
  if v_payment.payment_status<>'paid' and not v_legacy_unknown then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;
  if v_payment.event_id is distinct from v_event.id
    or v_payment.organization_id is distinct from v_event.organization_id then
    raise exception 'Pagamento diverge do evento ou organizacao da emissao.';
  end if;

  if v_item.item_kind = 'product' then
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
    where id=v_item.id;
    update public.order_item_pickup_units set status='confirmed', updated_at=now()
    where order_item_id=v_item.id and status='reserved';
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('order_item_product_confirmed','order_items',v_item.id,v_event.id,jsonb_build_object(
      'store_item_id',v_item.store_item_id,'order_id',v_order.id,'payment_id',v_payment.id,'organization_id',v_event.organization_id));
    return null;
  end if;

  insert into public.tickets(order_id,order_item_id,participant_id,event_id,organization_id,status)
  values(v_order.id,v_item.id,v_item.participant_id,v_event.id,v_event.organization_id,'active')
  on conflict(order_item_id) where order_item_id is not null do update set
    order_id=excluded.order_id,
    participant_id=excluded.participant_id,
    event_id=excluded.event_id,
    organization_id=excluded.organization_id
  returning id, status, (xmax = 0) into v_ticket_id, v_ticket_status, v_ticket_inserted;

  if v_ticket_status = 'cancelled' then
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('ticket_reactivation_blocked','tickets',v_ticket_id,v_event.id,jsonb_build_object(
      'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,
      'organization_id',v_event.organization_id,'reason','ticket_ja_cancelado_administrativamente_ou_por_estorno'));
    return null;
  end if;

  update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
  where id=v_item.id;

  if v_ticket_inserted then
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('ticket_issued','tickets',v_ticket_id,v_event.id,jsonb_build_object(
      'participant_id',v_item.participant_id,'order_id',v_order.id,'order_item_id',v_item.id,
      'payment_id',v_payment.id,'organization_id',v_event.organization_id,
      'price_origin',v_order.price_origin));
  end if;

  return v_ticket_id;
end; $$;

create or replace function public.finalize_imported_ticket_after_issue_resolution(
  p_order_item_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_payment public.payments%rowtype; v_batch public.import_batches%rowtype; v_ticket_id uuid; v_blocked boolean; v_finalization text;
  v_can_confirm boolean; v_legacy_unknown boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  if v_item.item_kind <> 'ticket' then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_ticket');
  end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported');
  end if;
  if not public.user_can_access_organization(v_actor,v_order.organization_id) and not exists(
    select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into v_batch from public.import_batches where id=v_order.import_batch_id for update;
  select * into v_payment from public.payments where id=v_order.payment_id for update;
  if not found then raise exception 'Pagamento importado nao encontrado.'; end if;
  v_legacy_unknown := public.is_legacy_import_unknown_price(v_order.price_origin, v_order.buyer_type, v_order.import_batch_id);
  select exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open' and i.blocks_ticket_issuance) into v_blocked;
  if v_blocked then
    v_finalization:='issues_remaining';
  elsif v_legacy_unknown then
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='legacy_unknown_ticket_issued';
  elsif v_payment.payment_status <> 'paid'
    and coalesce(v_batch.payment_mode_original,'pending')='pending'
    and not p_force_confirm then
    v_finalization:='payment_pending';
  else
    v_can_confirm := v_payment.payment_status='paid'
      or coalesce(v_batch.payment_mode_original,'pending')='confirm_all'
      or public.is_active_owner(v_actor)
      or public.resolve_user_permission(v_actor,'finance.confirm_payment');
    if not v_can_confirm then raise exception 'Sem permissao para confirmar o pagamento.'; end if;
    update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='paid_and_ticket_issued';
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_ticket_issue_finalized','order_items',v_item.id,v_item.event_id,jsonb_build_object(
    'order_item_id',v_item.id,'ticket_id',v_ticket_id,'registration_contact_id',v_item.registration_contact_id,
    'import_batch_id',v_batch.id,'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),'actor_user_id',v_actor,
    'finalization',v_finalization,'price_origin',v_order.price_origin));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,'payment_id',v_order.payment_id,
    'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id);
end; $$;

create or replace function public.import_current_event_contact_first(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_registration_contact_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default 'pix',p_import_issues jsonb default '[]'::jsonb,
  p_assign_holder boolean default true,p_intended_owner_contact_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_batch public.import_batches%rowtype; v_row public.import_batch_rows%rowtype;
  v_event public.events%rowtype; v_contact public.registration_contacts%rowtype;
  v_participant public.participants%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_payment public.payments%rowtype; v_ticket_id uuid; v_count integer; v_issue jsonb;
  v_cpf text:=nullif(regexp_replace(coalesce(p_cpf,''),'\D','','g'),'');
  v_email text:=lower(nullif(trim(coalesce(p_email,'')),''));
  v_phone text:=nullif(regexp_replace(coalesce(p_phone,''),'\D','','g'),'');
  v_amount numeric:=0; v_created_contact boolean:=false; v_created_participant boolean:=false;
  v_assign_holder boolean:=coalesce(p_assign_holder,true);
  v_intended uuid:=p_intended_owner_contact_id;
  v_source_amount numeric; v_price_origin text;
begin
  if v_actor is null or not public.current_user_has_permission('imports.view') then raise exception 'Sem permissao para importar cadastros.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id for update;
  if not found or v_batch.import_type<>'current_event_registrations' or v_batch.imported_by<>v_actor then raise exception 'Lote de importacao invalido.'; end if;
  select * into v_event from public.events where id=v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  select * into v_row from public.import_batch_rows where id=p_import_batch_row_id and import_batch_id=v_batch.id for update;
  if not found then raise exception 'Linha de importacao invalida.'; end if;

  if v_row.order_item_id is not null then
    select * into v_item from public.order_items where id=v_row.order_item_id;
    if found then
      select * into v_order from public.orders where id=v_item.order_id;
      select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
      return jsonb_build_object('registration_contact_id',v_item.registration_contact_id,'participant_id',v_item.participant_id,
        'order_id',v_item.order_id,'order_item_id',v_item.id,'payment_id',v_order.payment_id,'ticket_id',v_ticket_id,
        'created_contact',false,'created_participant_projection',false,'holder_assigned',v_item.ownership_status='assigned',
        'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_item.participant_id));
    end if;
  end if;

  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_registration_batch_id is not null and not exists(select 1 from public.registration_batches where id=p_registration_batch_id and event_id=v_event.id) then raise exception 'Lote nao pertence ao evento.'; end if;
  if p_ticket_category_id is not null and not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_event.id) then raise exception 'Categoria nao pertence ao evento.'; end if;

  if p_expected_registration_contact_id is not null then
    select * into v_contact from public.registration_contacts where id=p_expected_registration_contact_id and organization_id=v_event.organization_id for update;
    if not found then raise exception 'Cadastro indicado nao pertence a organizacao.'; end if;
    if public.is_valid_cpf(v_contact.cpf) and public.is_valid_cpf(v_cpf)
      and regexp_replace(v_contact.cpf,'\D','','g')<>v_cpf then raise exception 'CPF do cadastro indicado diverge da linha.'; end if;
  elsif public.is_valid_cpf(v_cpf) then
    select count(*),(array_agg(rc.id order by rc.id))[1] into v_count,v_contact.id
    from public.registration_contacts rc where rc.organization_id=v_event.organization_id
      and regexp_replace(coalesce(rc.cpf,''),'\D','','g')=v_cpf;
    if v_count>1 then raise exception 'Conflito de identidade: CPF possui mais de um cadastro. Revise a linha.'; end if;
    if v_count=1 then select * into v_contact from public.registration_contacts where id=v_contact.id for update; end if;
  end if;

  if v_contact.id is null then
    insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
    values(v_event.organization_id,trim(p_full_name),case when public.is_valid_cpf(v_cpf) then v_cpf end,p_birth_date,
      nullif(trim(p_gender),''),v_phone,v_email,nullif(trim(p_city),''),v_actor) returning * into v_contact;
    v_created_contact:=true;
  else
    update public.registration_contacts set
      full_name=case when nullif(trim(full_name),'') is null then trim(p_full_name) else full_name end,
      cpf=case when public.is_valid_cpf(cpf) then cpf when public.is_valid_cpf(v_cpf) then v_cpf else cpf end,
      birth_date=coalesce(birth_date,p_birth_date),gender=coalesce(gender,nullif(trim(p_gender),'')),
      phone=coalesce(phone,v_phone),email=coalesce(email,v_email),city=coalesce(city,nullif(trim(p_city),'')),updated_at=now()
    where id=v_contact.id returning * into v_contact;
  end if;

  v_intended:=coalesce(v_intended,v_row.intended_owner_contact_id,v_contact.id);
  if v_intended is not null and not exists(
    select 1 from public.registration_contacts rc where rc.id=v_intended and rc.organization_id=v_event.organization_id
  ) then raise exception 'Conta proprietaria indicada nao pertence a organizacao.'; end if;

  select * into v_participant from public.participants
  where event_id=v_event.id and registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      registration_status,reservation_status,notes)
    values(v_event.id,v_event.organization_id,v_contact.id,null,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,
      v_contact.phone,v_contact.email,v_contact.city,'pending','pending','LEGACY projection created by contact-first import')
    returning * into v_participant;
    v_created_participant:=true;
  end if;

  begin
    v_source_amount := nullif(btrim(coalesce(v_row.normalized_data->>'amount','')),'')::numeric;
  exception when invalid_text_representation then
    v_source_amount := null;
  end;
  v_price_origin := coalesce(nullif(btrim(coalesce(v_row.normalized_data->>'price_origin','')),''),
    case when v_source_amount is null then 'legacy_unknown' else 'legacy_provided' end);
  if v_price_origin not in ('legacy_unknown','legacy_provided','catalog') then
    v_price_origin := case when v_source_amount is null then 'legacy_unknown' else 'legacy_provided' end;
  end if;
  if v_price_origin = 'legacy_unknown' then
    v_amount := 0;
  else
    v_amount := coalesce(v_source_amount, 0);
  end if;

  if v_assign_holder and exists(
    select 1 from public.order_items oi
    where oi.event_id=v_event.id and oi.registration_contact_id=v_contact.id
      and coalesce(oi.ownership_status,'unassigned')='assigned'
      and oi.status not in('cancelled','expired','refunded')
  ) then v_assign_holder:=false; end if;

  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,price_origin)
  values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,coalesce(nullif(trim(p_payment_method),''),'pix'),'pending',v_price_origin) returning * into v_payment;
  insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id,price_origin)
  values(null,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id,v_price_origin) returning * into v_order;
  update public.payments set order_id=v_order.id where id=v_payment.id;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status,price_origin)
  values(v_order.id,v_event.id,case when v_assign_holder then v_participant.id end,v_contact.id,v_intended,
    case when v_assign_holder then 'assigned' else 'unassigned' end,case when v_assign_holder then v_contact.full_name end,
    p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved',v_price_origin) returning * into v_item;

  update public.import_batch_rows set registration_contact_id=v_contact.id,matched_participant_id=v_participant.id,
    matched_user_id=v_participant.user_id,order_item_id=v_item.id,ticket_id=null,intended_owner_contact_id=v_intended where id=v_row.id;

  for v_issue in select value from jsonb_array_elements(coalesce(p_import_issues,'[]'::jsonb)) loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,registration_contact_id,import_batch_id,order_item_id,ticket_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery,resolution_scope)
    values(v_event.organization_id,v_event.id,v_participant.id,v_contact.id,v_batch.id,v_item.id,null,
      v_issue->>'field_code',v_issue->>'issue_type',v_issue->>'message',coalesce((v_issue->>'blocks_payment')::boolean,false),
      coalesce((v_issue->>'blocks_ticket_issuance')::boolean,false),coalesce((v_issue->>'blocks_checkin')::boolean,false),
      coalesce((v_issue->>'blocks_kit_delivery')::boolean,false),
      coalesce(nullif(v_issue->>'resolution_scope',''), case when v_issue->>'field_code'='cpf' then 'user_resolvable' else 'admin_only' end))
    on conflict do nothing;
  end loop;
  update public.participant_data_issues set registration_contact_id=v_contact.id,order_item_id=v_item.id
    where participant_id=v_participant.id and import_batch_id=v_batch.id and status='open';

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values(case when v_created_contact then 'import_person_created' else 'import_person_reused' end,'registration_contacts',v_contact.id,v_event.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',v_batch.id,'import_batch_row_id',v_row.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'additional_purchase',not v_created_participant or not v_assign_holder,
      'holder_assigned',v_assign_holder,'intended_owner_contact_id',v_intended,'shirt_type',p_shirt_type,'shirt_size',p_shirt_size,
      'price_origin',v_price_origin,'legacy_amount',v_source_amount));

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id),
    'price_origin',v_price_origin);
end; $$;

create or replace function public.reevaluate_participant_data_issues("p_participant_id" "uuid", "p_import_batch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_e public.events%rowtype;
  v_price public.registration_batch_prices%rowtype; v_gender text; v_base numeric;
  v_age integer; v_open integer; v_issue record;
  v_batch_id uuid; v_category_id uuid; v_has_modern_order_item boolean;
  v_ticket_item public.order_items%rowtype; v_modern_order public.orders%rowtype; v_modern_payment public.payments%rowtype;
  v_ticket_reconciliation jsonb; v_legacy_historical boolean;
begin
  select * into v_p from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  select * into v_e from public.events where id=v_p.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if v_actor is not null and v_actor is distinct from v_p.user_id
    and not public.user_can_access_organization(v_actor,v_e.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  create temporary table if not exists pg_temp.expected_import_issues(
    field_code text,issue_type text,message text,blocks_payment boolean,
    blocks_ticket_issuance boolean,blocks_checkin boolean,blocks_kit_delivery boolean,
    primary key(field_code,issue_type)
  ) on commit drop;
  truncate pg_temp.expected_import_issues;

  if nullif(trim(coalesce(v_p.cpf,'')),'') is null then
    insert into pg_temp.expected_import_issues values('cpf','missing_required_identity','CPF obrigatorio ausente.',false,true,false,false);
  elsif not public.is_valid_cpf(v_p.cpf) then
    insert into pg_temp.expected_import_issues values('cpf','invalid_identity','CPF invalido.',false,true,false,false);
  end if;

  if nullif(trim(coalesce(v_p.email,'')),'') is not null
    and v_p.email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    insert into pg_temp.expected_import_issues values('email','invalid_format','E-mail informado e invalido.',false,false,false,false);
  end if;
  if nullif(regexp_replace(coalesce(v_p.phone,''),'\D','','g'),'') is not null
    and length(regexp_replace(v_p.phone,'\D','','g')) not in(10,11) then
    insert into pg_temp.expected_import_issues values('phone','invalid_format','Telefone informado e invalido.',false,false,false,false);
  end if;

  if v_p.birth_date is null then
    insert into pg_temp.expected_import_issues values('birth_date','missing_required_age','Data de nascimento obrigatoria ausente.',false,true,false,false);
  elsif v_e.starts_at is null then
    insert into pg_temp.expected_import_issues values('event_date','missing_required_for_age','Evento sem data de inicio para validar maioridade.',false,true,false,false);
  elsif v_p.birth_date>v_e.starts_at::date then
    insert into pg_temp.expected_import_issues values('birth_date','invalid_date','Nascimento posterior a data do evento.',false,true,false,false);
  else
    v_age:=extract(year from age(v_e.starts_at::date,v_p.birth_date));
    if v_age<18 then
      insert into pg_temp.expected_import_issues values('birth_date','underage_at_event','Pessoa menor de 18 anos na data do evento.',false,true,false,false);
    end if;
  end if;

  select oi.batch_id, oi.ticket_category_id into v_batch_id, v_category_id
    from public.order_items oi
    where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
    order by oi.created_at limit 1;
  v_batch_id := coalesce(v_batch_id, v_p.batch_id);
  v_category_id := coalesce(v_category_id, v_p.ticket_category_id);

  select exists(
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
      and public.is_legacy_import_historical_price(coalesce(oi.price_origin, o.price_origin))
  ) into v_legacy_historical;

  if v_batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_batch_id is not null and v_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_batch_id and ticket_category_id=v_category_id;
    if not found and not v_legacy_historical then
      insert into pg_temp.expected_import_issues values('price','unresolved','Preco nao encontrado para lote e categoria.',true,true,false,false);
    end if;
  end if;

  v_gender:=lower(trim(coalesce(v_p.gender,'')));
  if not v_legacy_historical
    and v_price.id is not null and v_price.male_price is distinct from v_price.female_price
    and v_gender not in('masculino','male','m','feminino','female','f') then
    insert into pg_temp.expected_import_issues values('gender','missing_required_for_pricing','Informe o genero para calcular o valor.',true,true,false,false);
  end if;

  if coalesce(v_e.limit_shirt_selection_to_stock,false)
    and exists(select 1 from public.event_kit_items where event_id=v_e.id and item_type='shirt' and is_active=true)
    and (nullif(trim(v_p.shirt_type),'') is null or nullif(trim(v_p.shirt_size),'') is null) then
    insert into pg_temp.expected_import_issues values('shirt_selection','missing_required_for_inventory','Modelo e tamanho da camiseta pendentes para o kit.',false,false,false,true);
  end if;

  update public.participant_data_issues i set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where i.participant_id=v_p.id and i.status='open'
    and i.field_code in('full_name','cpf','email','phone','city','birth_date','event_date','batch','category','price','gender','shirt_selection')
    and not exists(select 1 from pg_temp.expected_import_issues e where e.field_code=i.field_code and e.issue_type=i.issue_type);

  for v_issue in select * from pg_temp.expected_import_issues loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,import_batch_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_e.organization_id,v_e.id,v_p.id,p_import_batch_id,v_issue.field_code,v_issue.issue_type,
      v_issue.message,v_issue.blocks_payment,v_issue.blocks_ticket_issuance,v_issue.blocks_checkin,v_issue.blocks_kit_delivery)
    on conflict do nothing;
  end loop;

  if v_price.id is not null then
    v_base:=case when v_gender in('feminino','female','f') then v_price.female_price
      when v_gender in('masculino','male','m') then v_price.male_price
      when v_price.male_price=v_price.female_price then v_price.male_price end;
    if v_base is not null then
      v_has_modern_order_item := exists(
        select 1 from public.order_items oi where oi.participant_id = v_p.id and oi.item_kind = 'ticket'
      );
      if v_has_modern_order_item then
        for v_ticket_item in
          select * from public.order_items
          where participant_id = v_p.id and item_kind = 'ticket'
            and batch_id = v_batch_id and ticket_category_id = v_category_id
        loop
          select * into v_modern_order from public.orders where id = v_ticket_item.order_id;
          if found and not public.is_legacy_import_historical_price(coalesce(v_ticket_item.price_origin, v_modern_order.price_origin)) then
            select * into v_modern_payment from public.payments where id = v_modern_order.payment_id;
            if coalesce(v_modern_payment.payment_status,'pending') <> 'paid' then
              update public.order_items set unit_price=round(v_base,2), final_amount=round(v_base,2), updated_at=now() where id=v_ticket_item.id;
              update public.orders set base_amount=round(v_base,2), final_amount=round(v_base,2) where id=v_modern_order.id;
              if v_modern_payment.id is not null then
                update public.payments set amount=round(v_base,2), final_amount=round(v_base,2), updated_at=now() where id=v_modern_payment.id;
              end if;
            end if;
          end if;
        end loop;
      elsif not v_legacy_historical then
        update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
        where participant_id=v_p.id and payment_status<>'paid';
        if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
          insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
          values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
        end if;
      end if;
    end if;
  end if;

  if exists(select 1 from public.order_items oi where oi.participant_id = v_p.id and oi.item_kind = 'ticket') then
    v_ticket_reconciliation := public.reconcile_imported_ticket_issuance_for_participant(v_p.id);
  else
    v_ticket_reconciliation := jsonb_build_object('attempted', 0, 'results', '[]'::jsonb);
  end if;

  select count(*) into v_open from public.participant_data_issues where participant_id=v_p.id and status='open';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('participant_data_issues_reevaluated','participants',v_p.id,v_e.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'open_issue_count',v_open,'source',case when p_import_batch_id is null then 'edit' else 'import' end));
  return jsonb_build_object('participant_id',v_p.id,'open_issue_count',v_open,'price_defined',v_base is not null,'ticket_reconciliation',v_ticket_reconciliation);
end; $_$;

create or replace function public.resolve_ticket_data_issues(
  p_order_item_id uuid,p_expected_issue_ids uuid[],p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact_id uuid; v_ticket_id uuid; v_key text;
  v_current uuid[]; v_remaining jsonb; v_payment public.payments%rowtype;
  v_personal jsonb:='{}'::jsonb; v_category uuid; v_batch uuid; v_shirt_type text; v_shirt_size text;
  v_price public.registration_batch_prices%rowtype; v_amount numeric; v_ticket_reconciliation jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  select * into v_payment from public.payments where id=v_order.payment_id for update;
  if v_item.participant_id is not null then select * into v_participant from public.participants where id=v_item.participant_id for update; end if;
  v_contact_id:=coalesce(v_item.registration_contact_id,v_participant.registration_contact_id);
  if v_contact_id is null then raise exception 'Ingresso sem cadastro global vinculado.'; end if;
  if v_participant.user_id is distinct from v_actor and not(
    public.user_can_access_organization(v_actor,v_order.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic'))
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  perform 1 from public.participant_data_issues where order_item_id=v_item.id and status='open' for update;
  select coalesce(array_agg(id order by id),array[]::uuid[]) into v_current from public.participant_data_issues
    where order_item_id=v_item.id and status='open';
  if v_current is distinct from (select coalesce(array_agg(x order by x),array[]::uuid[]) from unnest(coalesce(p_expected_issue_ids,array[]::uuid[])) x)
    then return jsonb_build_object('success',false,'conflict',true,'message','As pendencias foram atualizadas. Recarregue e tente novamente.'); end if;
  for v_key in select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) loop
    if v_key in('full_name','cpf','birth_date','gender','phone','email','city') then v_personal:=v_personal||jsonb_build_object(v_key,p_values->v_key);
    elsif v_key not in('category','batch','shirt_type','shirt_size') then raise exception 'Campo de correcao nao permitido.'; end if;
  end loop;
  if v_personal<>'{}'::jsonb then perform public.update_registration_contact_from_participant(v_participant.id,v_personal); end if;
  v_category:=nullif(p_values->>'category','')::uuid; v_batch:=nullif(p_values->>'batch','')::uuid;
  if v_category is not null or v_batch is not null then
    perform public.resolve_import_ticket_options(v_item.id,coalesce(v_category,v_item.ticket_category_id),coalesce(v_batch,v_item.batch_id));
  elsif v_personal?'gender' and v_item.ticket_category_id is not null and v_item.batch_id is not null
    and coalesce(v_payment.payment_status,'pending')<>'paid'
    and not public.is_legacy_import_historical_price(coalesce(v_item.price_origin, v_order.price_origin)) then
    select * into v_price from public.registration_batch_prices
      where batch_id=v_item.batch_id and ticket_category_id=v_item.ticket_category_id;
    if found then
      v_amount:=case when lower(coalesce(p_values->>'gender','')) in('feminino','female','f') then v_price.female_price else v_price.male_price end;
      if v_amount is not null then
        update public.order_items set unit_price=v_amount,final_amount=v_amount,updated_at=now() where id=v_item.id;
        update public.orders set base_amount=v_amount,final_amount=v_amount where id=v_order.id;
        update public.payments set amount=v_amount,final_amount=v_amount,updated_at=now() where id=v_payment.id;
      end if;
    end if;
  end if;
  v_shirt_type:=nullif(trim(p_values->>'shirt_type'),''); v_shirt_size:=nullif(upper(trim(p_values->>'shirt_size')),'');
  if v_shirt_type is not null or v_shirt_size is not null then
    update public.order_items set shirt_type=coalesce(v_shirt_type,shirt_type),shirt_size=coalesce(v_shirt_size,shirt_size),updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is not null and v_shirt_type is not null and v_shirt_size is not null then perform public.admin_change_ticket_shirt(v_ticket_id,v_shirt_type,v_shirt_size); end if;
  end if;
  update public.participant_data_issues set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
  where order_item_id=v_item.id and status='open' and (
    field_code in(select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)))
    or (field_code='shirt_selection' and (p_values?'shirt_type' or p_values?'shirt_size'))
  );

  if v_participant.id is not null then
    v_ticket_reconciliation := public.reconcile_imported_ticket_issuance_for_participant(v_participant.id);
  else
    v_ticket_reconciliation := jsonb_build_object('attempted', 0, 'results', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'field_code',field_code,'issue_type',issue_type,'message',message,
    'blocks_payment',blocks_payment,'blocks_ticket_issuance',blocks_ticket_issuance,'blocks_checkin',blocks_checkin,'blocks_kit_delivery',blocks_kit_delivery)
    order by created_at),'[]'::jsonb) into v_remaining from public.participant_data_issues where order_item_id=v_item.id and status='open';
  select * into v_payment from public.payments where id=v_order.payment_id;
  return jsonb_build_object('success',true,'remaining_issues',v_remaining,'base_amount',v_payment.amount,
    'final_amount',v_payment.final_amount,'payment_status',coalesce(v_payment.payment_status,'pending'),'order_item_id',v_item.id,
    'ticket_reconciliation',v_ticket_reconciliation);
end; $$;

create or replace function public.resolve_import_ticket_options(
  p_order_item_id uuid, p_ticket_category_id uuid, p_batch_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_gender text;
  v_amount numeric;
  v_payment_status text;
  v_is_paid boolean := false;
  v_is_checked_in boolean := false;
  v_legacy_historical boolean := false;
begin
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if v_actor is null or not public.user_can_access_organization(v_actor, v_order.organization_id)
    or not (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor, 'participants.edit_basic')) then
    raise exception 'Sem permissao para corrigir o ingresso.';
  end if;

  if v_order.payment_id is not null then
    select payment_status into v_payment_status from public.payments where id = v_order.payment_id;
  end if;
  v_is_paid := coalesce(v_order.status, '') = 'confirmed'
    or v_item.status = 'confirmed'
    or coalesce(v_payment_status, '') = 'paid';
  select exists(
    select 1 from public.tickets t
    where t.order_item_id = v_item.id and (t.used_at is not null or t.status = 'used')
  ) into v_is_checked_in;

  if v_is_paid or v_is_checked_in then
    raise exception 'Este ingresso ja esta pago/confirmado (ou ja teve check-in) -- a correcao de categoria e lote pela importacao nao esta mais disponivel aqui. Use o fluxo administrativo de regularizacao financeira para este caso.';
  end if;

  if not exists(select 1 from public.ticket_categories where id = p_ticket_category_id and event_id = v_item.event_id and is_active) then
    raise exception 'Categoria invalida para o evento.';
  end if;
  if not exists(select 1 from public.registration_batches where id = p_batch_id and event_id = v_item.event_id and is_active) then
    raise exception 'Lote invalido para o evento.';
  end if;

  v_legacy_historical := public.is_legacy_import_historical_price(coalesce(v_item.price_origin, v_order.price_origin));
  if v_legacy_historical then
    update public.order_items set ticket_category_id = p_ticket_category_id, batch_id = p_batch_id, updated_at = now() where id = v_item.id;
    update public.participant_data_issues set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
      where order_item_id = v_item.id and status = 'open' and field_code in ('category', 'batch', 'price');
    return jsonb_build_object('success', true, 'order_item_id', v_item.id, 'amount', v_item.final_amount, 'price_origin', coalesce(v_item.price_origin, v_order.price_origin));
  end if;

  select coalesce(rc.gender, p.gender) into v_gender
    from public.participants p
    left join public.registration_contacts rc on rc.id = coalesce(v_item.registration_contact_id, p.registration_contact_id)
    where p.id = v_item.participant_id;
  select case when lower(coalesce(v_gender, '')) = 'female' then female_price else male_price end into v_amount
    from public.registration_batch_prices where batch_id = p_batch_id and ticket_category_id = p_ticket_category_id;
  if v_amount is null then raise exception 'Preco nao configurado para categoria e lote.'; end if;

  update public.order_items set ticket_category_id = p_ticket_category_id, batch_id = p_batch_id, unit_price = v_amount, final_amount = v_amount, updated_at = now() where id = v_item.id;
  update public.orders set base_amount = v_amount, final_amount = v_amount where id = v_order.id;
  update public.payments set amount = v_amount, final_amount = v_amount, updated_at = now() where id = v_order.payment_id and payment_status <> 'paid';
  update public.participant_data_issues set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where order_item_id = v_item.id and status = 'open' and field_code in ('category', 'batch', 'price');

  return jsonb_build_object('success', true, 'order_item_id', v_item.id, 'amount', v_amount);
end;
$$;

revoke all on function public.is_legacy_import_unknown_price(text,text,uuid) from public,anon;
grant execute on function public.is_legacy_import_unknown_price(text,text,uuid) to authenticated,service_role;
revoke all on function public.is_legacy_import_historical_price(text) from public,anon;
grant execute on function public.is_legacy_import_historical_price(text) to authenticated,service_role;

commit;
