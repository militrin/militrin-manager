-- Cadastro ≠ titular (importação).
-- Titular adicional explícito (identity_mode=textual_holder) materializa
-- holder_full_name sem INSERT em registration_contacts/participants.
-- Pessoa principal continua criando/reutilizando Cadastro.
-- Não limpa os 29 fantasmas históricos.

begin;

drop function if exists public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid);

create or replace function public.apply_shared_email_textual_holders(
  p_row_id uuid, p_owner_contact_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_row public.import_batch_rows%rowtype; v_batch public.import_batches%rowtype;
  v_owner public.registration_contacts%rowtype; v_email text; v_updated integer:=0;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_row from public.import_batch_rows where id=p_row_id for update;
  if not found then raise exception 'Linha de importacao nao encontrada.'; end if;
  select * into v_batch from public.import_batches where id=v_row.import_batch_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_batch.organization_id)
    or not public.resolve_user_permission(v_actor,'imports.view') then
    raise exception 'Sem permissao para revisar esta importacao.';
  end if;
  if not public.resolve_user_permission(v_actor,'participants.edit_basic') then
    raise exception 'Sem permissao para definir titular textual.';
  end if;
  select * into v_owner from public.registration_contacts
    where id=p_owner_contact_id and organization_id=v_batch.organization_id;
  if not found then raise exception 'Cadastro proprietario invalido para esta organizacao.'; end if;
  v_email:=lower(trim(coalesce(v_row.normalized_data->>'email','')));

  -- Sem heurística de nome: se a linha atual JÁ é o Cadastro owner, os irmãos
  -- do mesmo e-mail viram titular textual. Caso contrário, só esta linha.
  -- Linhas pending de outra pessoa no mesmo e-mail continuam exigindo decisão explícita.
  if v_row.registration_contact_id is not distinct from v_owner.id and v_email<>'' then
    update public.import_batch_rows r
      set intended_owner_contact_id=v_owner.id,
          review_decision=coalesce(nullif(r.review_decision,'pending'),'import_as_textual_holder'),
          reviewed_by=v_actor,reviewed_at=coalesce(r.reviewed_at,now()),updated_at=now(),
          identity_match_details=coalesce(r.identity_match_details,'{}'::jsonb)||jsonb_build_object(
            'identity_mode','textual_holder',
            'account_review_resolved','assign_owner_contact',
            'intended_owner_contact_id',v_owner.id),
          status=case when r.status='imported' then r.status else 'ready' end,
          resolution='textual_holder'
      where r.import_batch_id=v_batch.id
        and r.id is distinct from v_row.id
        and r.status is distinct from 'imported'
        and r.registration_contact_id is distinct from v_owner.id
        and lower(trim(coalesce(r.normalized_data->>'email','')))=v_email;
    get diagnostics v_updated = row_count;
  else
    update public.import_batch_rows r
      set intended_owner_contact_id=v_owner.id,
          review_decision='import_as_textual_holder',
          reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),
          identity_match_details=coalesce(r.identity_match_details,'{}'::jsonb)||jsonb_build_object(
            'identity_mode','textual_holder',
            'account_review_resolved','assign_owner_contact',
            'intended_owner_contact_id',v_owner.id),
          status=case when r.status='imported' then r.status else 'ready' end,
          resolution='textual_holder'
      where r.id=v_row.id
        and r.status is distinct from 'imported'
        and r.registration_contact_id is distinct from v_owner.id;
    get diagnostics v_updated = row_count;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('import_textual_holder_mode_applied','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'import_batch_id',v_batch.id,'owner_registration_contact_id',v_owner.id,
    'rows_marked_textual',v_updated,'shared_email',nullif(v_email,'')));
  return jsonb_build_object('success',true,'textual_holder_rows',v_updated,'owner_registration_contact_id',v_owner.id);
end; $$;

create or replace function public.import_current_event_contact_first(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_registration_contact_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default null,p_import_issues jsonb default '[]'::jsonb,
  p_assign_holder boolean default true,p_intended_owner_contact_id uuid default null,
  p_identity_mode text default 'cadastro'
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
  v_identity_mode text;
  v_owner_user uuid;
  v_holder_name text;
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
        'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_item.participant_id),
        'identity_mode',coalesce(v_row.identity_match_details->>'identity_mode','cadastro'));
    end if;
  end if;

  if nullif(trim(p_full_name),'') is null then raise exception 'Nome obrigatorio ausente.'; end if;
  if p_registration_batch_id is not null and not exists(select 1 from public.registration_batches where id=p_registration_batch_id and event_id=v_event.id) then raise exception 'Lote nao pertence ao evento.'; end if;
  if p_ticket_category_id is not null and not exists(select 1 from public.ticket_categories where id=p_ticket_category_id and event_id=v_event.id) then raise exception 'Categoria nao pertence ao evento.'; end if;

  v_identity_mode:=lower(nullif(trim(coalesce(p_identity_mode,'')),''));
  v_identity_mode:=coalesce(nullif(v_identity_mode,''),nullif(v_row.identity_match_details->>'identity_mode',''),'cadastro');
  if v_row.resolution='textual_holder' then v_identity_mode:='textual_holder'; end if;

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
  if v_price_origin = 'legacy_unknown' then v_amount := 0; else v_amount := coalesce(v_source_amount, 0); end if;

  if v_identity_mode='textual_holder' then
    v_intended:=coalesce(v_intended,v_row.intended_owner_contact_id);
    if v_intended is null then
      raise exception 'Titular textual exige a conta proprietaria (Cadastro) escolhida na revisao.';
    end if;
    select * into v_contact from public.registration_contacts
      where id=v_intended and organization_id=v_event.organization_id;
    if not found then raise exception 'Conta proprietaria indicada nao pertence a organizacao.'; end if;
    v_owner_user:=v_contact.user_id;
    v_holder_name:=trim(p_full_name);
    select * into v_participant from public.participants
      where event_id=v_event.id and registration_contact_id=v_contact.id limit 1;
    if v_participant.id is null then
      raise exception 'Importe primeiro o Cadastro proprietario antes do titular textual.';
    end if;
    insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,price_origin)
    values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,nullif(btrim(coalesce(p_payment_method,'')),''),'pending',v_price_origin)
    returning * into v_payment;
    insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id,price_origin)
    values(v_owner_user,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id,v_price_origin)
    returning * into v_order;
    update public.payments set order_id=v_order.id where id=v_payment.id;
    insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,
      ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status,price_origin)
    values(v_order.id,v_event.id,null,null,v_intended,'assigned',v_holder_name,
      p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved',v_price_origin)
    returning * into v_item;
    update public.import_batch_rows set registration_contact_id=null,matched_participant_id=null,
      matched_user_id=null,order_item_id=v_item.id,ticket_id=null,intended_owner_contact_id=v_intended,
      identity_match_details=coalesce(identity_match_details,'{}'::jsonb)||jsonb_build_object('identity_mode','textual_holder')
      where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_textual_holder_created','order_items',v_item.id,v_event.id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,'import_batch_row_id',v_row.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'holder_full_name',v_holder_name,
      'intended_owner_contact_id',v_intended,'created_contact',false,'identity_mode','textual_holder'));
    return jsonb_build_object('registration_contact_id',null,'participant_id',null,
      'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
      'created_contact',false,'created_participant_projection',false,'holder_assigned',true,
      'has_issuance_blockers',false,'price_origin',v_price_origin,'identity_mode','textual_holder');
  end if;

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

  if v_assign_holder and exists(
    select 1 from public.order_items oi
    where oi.event_id=v_event.id and oi.registration_contact_id=v_contact.id
      and coalesce(oi.ownership_status,'unassigned')='assigned'
      and oi.status not in('cancelled','expired','refunded')
  ) then v_assign_holder:=false; end if;

  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status,price_origin)
  values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,nullif(btrim(coalesce(p_payment_method,'')),''),'pending',v_price_origin) returning * into v_payment;
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
      'price_origin',v_price_origin,'legacy_amount',v_source_amount,'identity_mode','cadastro'));

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id),
    'price_origin',v_price_origin,'identity_mode','cadastro');
end; $$;

grant execute on function public.apply_shared_email_textual_holders(uuid,uuid) to authenticated, service_role;
grant execute on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid,text) to authenticated, service_role;

comment on function public.apply_shared_email_textual_holders(uuid,uuid) is
  'Marca linhas adicionais de e-mail compartilhado como titular textual. Nao cria Cadastro. Nao altera tickets ja importados.';
comment on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid,text) is
  'identity_mode=cadastro cria/reutiliza registration_contact. identity_mode=textual_holder grava so holder_full_name.';

commit;
