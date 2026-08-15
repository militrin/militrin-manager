-- Fase 2: escrita canonica contact-first para importacoes.
-- O baseline reconciliado permanece imutavel; participants e somente uma projecao legada.
begin;

alter table public.registration_contacts
  alter column cpf drop not null,
  alter column birth_date drop not null,
  alter column phone drop not null,
  alter column email drop not null;

alter table public.import_batch_rows
  add column if not exists registration_contact_id uuid references public.registration_contacts(id) on delete set null,
  add column if not exists order_item_id uuid references public.order_items(id) on delete set null,
  add column if not exists ticket_id uuid references public.tickets(id) on delete set null;

alter table public.import_batches
  add column if not exists organization_id uuid references public.organizations(id) on delete restrict;

alter table public.participant_data_issues
  alter column participant_id drop not null,
  add column if not exists registration_contact_id uuid references public.registration_contacts(id) on delete set null,
  add column if not exists order_item_id uuid references public.order_items(id) on delete set null,
  add column if not exists ticket_id uuid references public.tickets(id) on delete set null;

alter table public.participation_history
  add column if not exists registration_contact_id uuid references public.registration_contacts(id) on delete set null;

create index if not exists import_batch_rows_contact_idx on public.import_batch_rows(registration_contact_id);
create index if not exists participant_data_issues_ticket_idx on public.participant_data_issues(ticket_id) where status='open';
create index if not exists participant_data_issues_contact_idx on public.participant_data_issues(registration_contact_id) where status='open';
create index if not exists participation_history_contact_idx on public.participation_history(registration_contact_id);

comment on column public.import_batch_rows.registration_contact_id is 'Identidade canonica resolvida para a linha importada.';
comment on column public.participant_data_issues.participant_id is 'LEGACY: projecao event-scoped; use registration_contact_id e os vinculos do ingresso.';
comment on column public.participation_history.participant_id is 'LEGACY: projecao event-scoped; registration_contact_id identifica a pessoa.';

create or replace function public.resolve_import_registration_contact(
  p_organization_id uuid,p_expected_registration_contact_id uuid,p_full_name text,p_cpf text,
  p_birth_date date,p_gender text,p_phone text,p_email text,p_city text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_contact public.registration_contacts%rowtype; v_count integer;
  v_cpf text:=nullif(regexp_replace(coalesce(p_cpf,''),'\D','','g'),''); v_created boolean:=false;
begin
  if v_actor is null or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Organizacao invalida ou sem acesso.'; end if;
  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_expected_registration_contact_id is not null then
    select * into v_contact from public.registration_contacts where id=p_expected_registration_contact_id and organization_id=p_organization_id for update;
    if not found then raise exception 'Cadastro indicado nao pertence a organizacao.'; end if;
  elsif public.is_valid_cpf(v_cpf) then
    select count(*) into v_count from public.registration_contacts where organization_id=p_organization_id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf;
    if v_count>1 then raise exception 'Conflito de identidade: CPF possui mais de um cadastro. Revise a linha.'; end if;
    if v_count=1 then select * into v_contact from public.registration_contacts where organization_id=p_organization_id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf for update; end if;
  end if;
  if v_contact.id is null then
    insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
    values(p_organization_id,trim(p_full_name),case when public.is_valid_cpf(v_cpf) then v_cpf end,p_birth_date,nullif(trim(p_gender),''),
      nullif(regexp_replace(coalesce(p_phone,''),'\D','','g'),''),lower(nullif(trim(p_email),'')),nullif(trim(p_city),''),v_actor)
    returning * into v_contact; v_created:=true;
  end if;
  return jsonb_build_object('registration_contact_id',v_contact.id,'created',v_created);
end; $$;

create or replace function public.import_current_event_contact_first(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_registration_contact_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default 'pix',p_import_issues jsonb default '[]'::jsonb,
  p_assign_holder boolean default true
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
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id for update;
  if not found or v_batch.import_type<>'current_event_registrations' or v_batch.imported_by<>v_actor then raise exception 'Lote de importacao invalido.'; end if;
  select * into v_event from public.events where id=v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  select * into v_row from public.import_batch_rows where id=p_import_batch_row_id and import_batch_id=v_batch.id for update;
  if not found then raise exception 'Linha de importacao invalida.'; end if;
  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_registration_batch_id is not null and not exists(select 1 from public.registration_batches where id=p_registration_batch_id and event_id=v_event.id) then raise exception 'Lote nao pertence ao evento.'; end if;
  if p_ticket_category_id is not null and not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_event.id) then raise exception 'Categoria nao pertence ao evento.'; end if;

  -- Identidade deterministica: vinculo canonico explicito ou CPF valido e unico na organizacao.
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

  -- Projecao legada necessaria para consumidores ainda event-scoped. Dados pessoais sao espelho do contato.
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

  if p_registration_batch_id is not null and p_ticket_category_id is not null then
    select case when lower(coalesce(p_gender,''))='female' then female_price else male_price end into v_amount
    from public.registration_batch_prices where batch_id=p_registration_batch_id and ticket_category_id=p_ticket_category_id;
  end if;
  v_amount:=coalesce(v_amount,0);

  -- Nunca atribui a mesma pessoa implicitamente a mais de um ingresso do evento.
  if v_assign_holder and exists(
    select 1 from public.order_items oi
    where oi.event_id=v_event.id and oi.registration_contact_id=v_contact.id
      and oi.status not in('cancelled','expired','refunded')
  ) then v_assign_holder:=false; end if;

  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status)
  values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,coalesce(nullif(trim(p_payment_method),''),'pix'),'pending') returning * into v_payment;
  insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id)
  values(null,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id) returning * into v_order;
  update public.payments set order_id=v_order.id where id=v_payment.id;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status)
  values(v_order.id,v_event.id,case when v_assign_holder then v_participant.id end,case when v_assign_holder then v_contact.id end,
    case when v_assign_holder then 'assigned' else 'unassigned' end,case when v_assign_holder then v_contact.full_name end,
    p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved') returning * into v_item;

  update public.import_batch_rows set registration_contact_id=v_contact.id,matched_participant_id=v_participant.id,
    matched_user_id=v_participant.user_id,order_item_id=v_item.id,ticket_id=null where id=v_row.id;

  for v_issue in select value from jsonb_array_elements(coalesce(p_import_issues,'[]'::jsonb)) loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,registration_contact_id,import_batch_id,order_item_id,ticket_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_event.organization_id,v_event.id,v_participant.id,v_contact.id,v_batch.id,v_item.id,null,
      v_issue->>'field_code',v_issue->>'issue_type',v_issue->>'message',coalesce((v_issue->>'blocks_payment')::boolean,false),
      coalesce((v_issue->>'blocks_ticket_issuance')::boolean,false),coalesce((v_issue->>'blocks_checkin')::boolean,false),
      coalesce((v_issue->>'blocks_kit_delivery')::boolean,false)) on conflict do nothing;
  end loop;
  update public.participant_data_issues set registration_contact_id=v_contact.id,order_item_id=v_item.id
    where participant_id=v_participant.id and import_batch_id=v_batch.id and status='open';

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id));
end; $$;

create or replace function public.finalize_imported_ticket_after_issue_resolution(
  p_order_item_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_payment public.payments%rowtype; v_batch public.import_batches%rowtype; v_ticket_id uuid; v_blocked boolean; v_finalization text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported'); end if;
  if not public.user_can_access_organization(v_actor,v_order.organization_id) and not exists(
    select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into v_batch from public.import_batches where id=v_order.import_batch_id for update;
  select exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open' and i.blocks_ticket_issuance) into v_blocked;
  if v_blocked then v_finalization:='issues_remaining';
  elsif coalesce(v_batch.payment_mode_original,'pending')='pending' and not p_force_confirm then v_finalization:='payment_pending';
  else
    if not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then raise exception 'Sem permissao para confirmar o pagamento.'; end if;
    select * into v_payment from public.payments where id=v_order.payment_id for update;
    update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='paid_and_ticket_issued';
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_ticket_issue_finalized','order_items',v_item.id,v_item.event_id,jsonb_build_object(
    'order_item_id',v_item.id,'ticket_id',v_ticket_id,'registration_contact_id',v_item.registration_contact_id,
    'import_batch_id',v_batch.id,'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),'actor_user_id',v_actor,'finalization',v_finalization));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,'payment_id',v_order.payment_id,
    'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id);
end; $$;

create or replace function public.resolve_import_ticket_options(
  p_order_item_id uuid,p_ticket_category_id uuid,p_batch_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_gender text; v_amount numeric;
begin
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_actor is null or not public.user_can_access_organization(v_actor,v_order.organization_id)
    or not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic')) then raise exception 'Sem permissao para corrigir o ingresso.'; end if;
  if not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_item.event_id and is_active) then raise exception 'Categoria invalida para o evento.'; end if;
  if not exists(select 1 from public.registration_batches where id=p_batch_id and event_id=v_item.event_id and is_active) then raise exception 'Lote invalido para o evento.'; end if;
  select coalesce(rc.gender,p.gender) into v_gender from public.participants p left join public.registration_contacts rc on rc.id=coalesce(v_item.registration_contact_id,p.registration_contact_id) where p.id=v_item.participant_id;
  select case when lower(coalesce(v_gender,''))='female' then female_price else male_price end into v_amount
    from public.registration_batch_prices where batch_id=p_batch_id and ticket_category_id=p_ticket_category_id;
  if v_amount is null then raise exception 'Preco nao configurado para categoria e lote.'; end if;
  update public.order_items set ticket_category_id=p_ticket_category_id,batch_id=p_batch_id,unit_price=v_amount,final_amount=v_amount,updated_at=now() where id=v_item.id;
  update public.orders set base_amount=v_amount,final_amount=v_amount where id=v_order.id;
  update public.payments set amount=v_amount,final_amount=v_amount,updated_at=now() where id=v_order.payment_id and payment_status<>'paid';
  update public.participant_data_issues set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
    where order_item_id=v_item.id and status='open' and field_code in('category','batch','price');
  return jsonb_build_object('success',true,'order_item_id',v_item.id,'amount',v_amount);
end; $$;

create or replace function public.update_registration_contact_from_participant(
  p_participant_id uuid,p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype;
  v_key text; v_allowed constant text[]:=array['full_name','cpf','birth_date','gender','phone','email','city'];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found or v_participant.registration_contact_id is null then raise exception 'Cadastro global nao vinculado.'; end if;
  if v_participant.user_id is distinct from v_actor and not(
    public.user_can_access_organization(v_actor,v_participant.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic'))
  ) then raise exception 'Usuario sem acesso ao cadastro.'; end if;
  for v_key in select jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) loop
    if not(v_key=any(v_allowed)) then raise exception 'Campo pessoal nao permitido.'; end if;
  end loop;
  if p_values?'cpf' and nullif(p_values->>'cpf','') is not null and not public.is_valid_cpf(p_values->>'cpf') then raise exception 'CPF invalido.'; end if;
  update public.registration_contacts rc set
    full_name=case when p_values?'full_name' then nullif(trim(p_values->>'full_name'),'') else rc.full_name end,
    cpf=case when p_values?'cpf' then nullif(regexp_replace(p_values->>'cpf','\D','','g'),'') else rc.cpf end,
    birth_date=case when p_values?'birth_date' then nullif(trim(p_values->>'birth_date'),'')::date else rc.birth_date end,
    gender=case when p_values?'gender' then nullif(trim(p_values->>'gender'),'') else rc.gender end,
    phone=case when p_values?'phone' then nullif(regexp_replace(p_values->>'phone','\D','','g'),'') else rc.phone end,
    email=case when p_values?'email' then lower(nullif(trim(p_values->>'email'),'')) else rc.email end,
    city=case when p_values?'city' then nullif(trim(p_values->>'city'),'') else rc.city end,
    updated_at=now()
  where rc.id=v_participant.registration_contact_id returning * into v_contact;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_contact_personal_data_updated','registration_contacts',v_contact.id,v_participant.event_id,
    jsonb_build_object('actor_user_id',v_actor,'participant_projection_id',v_participant.id,'fields_updated',
      (select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) k)));
  return jsonb_build_object('success',true,'registration_contact_id',v_contact.id);
end; $$;

create or replace function public.resolve_ticket_data_issues(
  p_order_item_id uuid,p_expected_issue_ids uuid[],p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact_id uuid; v_ticket_id uuid; v_key text;
  v_current uuid[]; v_remaining jsonb; v_payment public.payments%rowtype;
  v_personal jsonb:='{}'::jsonb; v_category uuid; v_batch uuid; v_shirt_type text; v_shirt_size text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
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
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'field_code',field_code,'issue_type',issue_type,'message',message,
    'blocks_payment',blocks_payment,'blocks_ticket_issuance',blocks_ticket_issuance,'blocks_checkin',blocks_checkin,'blocks_kit_delivery',blocks_kit_delivery)
    order by created_at),'[]'::jsonb) into v_remaining from public.participant_data_issues where order_item_id=v_item.id and status='open';
  select * into v_payment from public.payments where id=v_order.payment_id;
  return jsonb_build_object('success',true,'remaining_issues',v_remaining,'base_amount',v_payment.amount,
    'final_amount',v_payment.final_amount,'payment_status',coalesce(v_payment.payment_status,'pending'),'order_item_id',v_item.id);
end; $$;

-- A assinatura antiga nao possui contexto suficiente quando uma pessoa tem varios ingressos.
create or replace function public.resolve_participant_data_issues(p_participant_id uuid,p_expected_issue_ids uuid[],p_values jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'Abra a pendencia no ingresso correto para continuar.' using errcode='P0001'; end; $$;

create or replace function public.finalize_imported_participant_after_issue_resolution(
  p_participant_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'Informe o ingresso comercial explicitamente para finalizar.' using errcode='P0001'; end; $$;

-- Entradas antigas sem contexto comercial ficam deliberadamente indisponiveis.
create or replace function public.create_imported_order_and_issue_ticket(p_participant_id uuid,p_import_batch_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'RPC legada desativada: use o fluxo contact-first por order_item_id.' using errcode='P0001'; end; $$;

create or replace function public.create_pending_imported_participant(
  p_import_batch_id uuid,p_full_name text,p_cpf text default null,p_birth_date date default null,p_gender text default null,
  p_phone text default null,p_email text default null,p_city text default null,p_shirt_type text default null,p_shirt_size text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'RPC legada desativada: use import_current_event_contact_first.' using errcode='P0001'; end; $$;

create or replace function public.upsert_current_event_import_participant(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_participant_id uuid,p_full_name text,p_cpf text,
  p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,p_shirt_type text,p_shirt_size text,
  p_registration_batch_id uuid,p_ticket_category_id uuid,p_payment_method text default 'pix',p_import_issues jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'RPC legada desativada: use import_current_event_contact_first.' using errcode='P0001'; end; $$;

-- Checkout publico contact-first. A projecao participant guarda somente identidade
-- event-scoped e snapshots necessarios aos consumidores legados de Central/Retirada.
create or replace function public.create_registration(
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_status text,p_notes text,p_payment_method text,
  p_payment_status text,p_event_id uuid,p_coupon_code text default null,p_ticket_category_id uuid default null
) returns table(participant_id uuid,full_name text,batch_name text,base_amount numeric,discount_amount numeric,
  final_amount numeric,payment_status text,reservation_expires_at timestamptz,shirt_type text,shirt_size text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_contact_id uuid; v_contact_result jsonb;
  v_participant public.participants%rowtype; v_batch public.registration_batches%rowtype; v_category uuid;
  v_base numeric; v_discount numeric:=0; v_final numeric; v_pay_status text:=coalesce(nullif(trim(p_payment_status),''),'pending');
  v_method text:=coalesce(nullif(trim(p_payment_method),''),'pix'); v_expiry timestamptz; v_payment_id uuid; v_order_id uuid; v_item_id uuid;
  v_coupon record; v_shirt_type text:=coalesce(nullif(trim(p_shirt_type),''),'Sem camiseta');
  v_shirt_size text:=coalesce(nullif(upper(trim(p_shirt_size)),''),'N/A');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not coalesce(v_event.registration_enabled,false) then raise exception 'Evento indisponivel para inscricao.'; end if;
  v_contact_result:=public.resolve_import_registration_contact(v_event.organization_id,null,p_full_name,p_cpf,p_birth_date,p_gender,p_phone,p_email,p_city);
  v_contact_id:=(v_contact_result->>'registration_contact_id')::uuid;
  select * into v_participant from public.participants where event_id=v_event.id and registration_contact_id=v_contact_id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      registration_status,reservation_status,notes)
    select v_event.id,v_event.organization_id,rc.id,v_actor,rc.full_name,rc.cpf,rc.birth_date,rc.gender,rc.phone,rc.email,rc.city,
      'pending','pending',p_notes from public.registration_contacts rc where rc.id=v_contact_id returning * into v_participant;
  elsif v_participant.user_id is not null and v_participant.user_id<>v_actor then raise exception 'Cadastro ja vinculado a outra conta neste evento.';
  else update public.participants set user_id=v_actor,notes=coalesce(p_notes,notes),updated_at=now() where id=v_participant.id returning * into v_participant;
  end if;
  perform public.update_registration_contact_from_participant(v_participant.id,jsonb_build_object(
    'full_name',p_full_name,'cpf',p_cpf,'birth_date',p_birth_date,'gender',p_gender,'phone',p_phone,'email',p_email,'city',p_city));
  select * into v_batch from public.registration_batches where event_id=v_event.id and is_active
    and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>=now()) order by sequence_number limit 1 for update;
  if not found then raise exception 'Inscricoes encerradas ou lotes esgotados.'; end if;
  if p_ticket_category_id is not null then v_category:=p_ticket_category_id;
  else select id into v_category from public.ticket_categories where event_id=v_event.id and is_active order by sort_order,name limit 1; end if;
  if not exists(select 1 from public.ticket_categories where id=v_category and event_id=v_event.id and is_active) then raise exception 'Categoria invalida para o evento.'; end if;
  select case when lower(coalesce(p_gender,'')) in('female','feminino','f') then female_price else male_price end
    into v_base from public.registration_batch_prices where batch_id=v_batch.id and ticket_category_id=v_category;
  if v_base is null then raise exception 'Preco nao configurado para categoria e lote.'; end if;
  v_final:=v_base;
  if coalesce(trim(p_coupon_code),'')<>'' then
    select * into v_coupon from public.validate_coupon(trim(p_coupon_code),v_event.id,v_base) limit 1;
    v_discount:=coalesce(v_coupon.discount_amount,0); v_final:=coalesce(v_coupon.final_amount,v_base);
    if coalesce(v_coupon.coupon_type,'')='courtesy' then v_pay_status:='paid'; v_method:='courtesy'; end if;
  end if;
  if lower(v_method)='courtesy' then v_pay_status:='paid'; end if;
  v_expiry:=case when v_pay_status='paid' then null else now()+interval '2 hours' end;
  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at,expires_at)
  values(v_participant.id,v_event.id,v_event.organization_id,v_base,v_discount,v_final,v_method,v_pay_status,
    case when v_pay_status='paid' then now() end,v_expiry) returning id into v_payment_id;
  insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
  values(v_actor,v_participant.id,v_event.id,v_event.organization_id,v_payment_id,public.generate_order_number(),
    case when v_pay_status='paid' then 'confirmed' else 'pending' end,v_base,v_discount,v_final,'account',case when v_pay_status='paid' then now() end)
  returning id into v_order_id;
  update public.payments set order_id=v_order_id where id=v_payment_id;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status,reservation_expires_at)
  values(v_order_id,v_event.id,v_participant.id,v_contact_id,'assigned',p_full_name,v_category,v_batch.id,v_shirt_type,v_shirt_size,
    1,v_base,v_discount,v_final,case when v_pay_status='paid' then 'confirmed' else 'reserved' end,v_expiry) returning id into v_item_id;
  if v_pay_status='paid' then perform public.confirm_order_item_and_issue_ticket(v_item_id); end if;
  return query select v_participant.id,p_full_name,v_batch.name,v_base,v_discount,v_final,v_pay_status,v_expiry,v_shirt_type,v_shirt_size;
end; $$;

create or replace function public.ensure_order_for_participant(p_participant_id uuid,p_user_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_payment public.payments%rowtype;
  v_order public.orders%rowtype; v_item public.order_items%rowtype; v_status text;
begin
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  if coalesce(p_user_id,v_actor) is null then raise exception 'Usuario da conta obrigatorio.'; end if;
  if v_participant.user_id is null then update public.participants set user_id=coalesce(p_user_id,v_actor),updated_at=now() where id=v_participant.id;
  elsif v_participant.user_id<>coalesce(p_user_id,v_actor) then raise exception 'Participante ja vinculado a outra conta.'; end if;
  select * into v_payment from public.payments where participant_id=v_participant.id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado.'; end if;
  select * into v_order from public.orders where payment_id=v_payment.id for update;
  if not found then raise exception 'Pedido canonico nao encontrado para o pagamento.'; end if;
  select * into v_item from public.order_items where order_id=v_order.id for update;
  if not found then raise exception 'Item canonico nao encontrado para o pedido.'; end if;
  v_status:=case when v_payment.payment_status='paid' then 'confirmed' when v_payment.payment_status in('cancelled','expired','refunded') then v_payment.payment_status else 'pending' end;
  update public.orders set status=v_status,confirmed_at=case when v_status='confirmed' then coalesce(confirmed_at,now()) else confirmed_at end where id=v_order.id;
  update public.order_items set status=case when v_status='pending' then 'reserved' else v_status end,
    reservation_expires_at=case when v_status='confirmed' then null else reservation_expires_at end,updated_at=now() where id=v_item.id;
  return v_order.id;
end; $$;

-- LEGADO NECESSARIO: participants.user_id ainda e a chave de compatibilidade
-- consumida por convites e pelo portal. Nao replica dados pessoais.
create or replace function public.link_participant_account_projection(p_participant_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  update public.participants set user_id=v_actor,updated_at=now()
    where id=p_participant_id and (user_id is null or user_id=v_actor);
  if not found then raise exception 'Projecao vinculada a outra conta.'; end if;
  return true;
end; $$;

-- LEGADO NECESSARIO: notes e anotacao interna event-scoped consumida pela ficha
-- antiga de inscricao; nao representa dado pessoal nem estado do ingresso.
create or replace function public.update_participant_event_notes(p_participant_id uuid,p_notes text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_org uuid;
begin
  select organization_id into v_org from public.participants where id=p_participant_id;
  if v_actor is null or v_org is null or not public.user_can_access_organization(v_actor,v_org)
    or not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic')) then raise exception 'Sem acesso a anotacao.'; end if;
  update public.participants set notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now() where id=p_participant_id;
  return true;
end; $$;

revoke all on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean) from public,anon;
revoke all on function public.resolve_import_registration_contact(uuid,uuid,text,text,date,text,text,text,text) from public,anon;
revoke all on function public.finalize_imported_ticket_after_issue_resolution(uuid,text[],boolean) from public,anon;
revoke all on function public.resolve_import_ticket_options(uuid,uuid,uuid) from public,anon;
revoke all on function public.update_registration_contact_from_participant(uuid,jsonb) from public,anon;
revoke all on function public.resolve_ticket_data_issues(uuid,uuid[],jsonb) from public,anon;
revoke all on function public.link_participant_account_projection(uuid) from public,anon;
revoke all on function public.update_participant_event_notes(uuid,text) from public,anon;
revoke all on function public.create_imported_order_and_issue_ticket(uuid,uuid) from public,anon,authenticated;
revoke all on function public.create_pending_imported_participant(uuid,text,text,date,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.upsert_current_event_import_participant(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean) to authenticated,service_role;
grant execute on function public.resolve_import_registration_contact(uuid,uuid,text,text,date,text,text,text,text) to authenticated,service_role;
grant execute on function public.finalize_imported_ticket_after_issue_resolution(uuid,text[],boolean) to authenticated,service_role;
grant execute on function public.resolve_import_ticket_options(uuid,uuid,uuid) to authenticated,service_role;
grant execute on function public.update_registration_contact_from_participant(uuid,jsonb) to authenticated,service_role;
grant execute on function public.resolve_ticket_data_issues(uuid,uuid[],jsonb) to authenticated,service_role;
grant execute on function public.link_participant_account_projection(uuid) to authenticated,service_role;
grant execute on function public.update_participant_event_notes(uuid,text) to authenticated,service_role;

commit;
