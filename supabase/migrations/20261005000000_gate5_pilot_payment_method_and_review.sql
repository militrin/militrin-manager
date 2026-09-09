-- GATE #5 post-pilot: empty payment_method stays unknown (never pix).
-- Scoped repair of the already-materialized official 8-row pilot only.
-- source_file_hash = e0e3602c09c3d9b8ab009b58cc8701389b4538b9640241312a8d346af685365e
-- Official 482 hash must remain absent from import_batches.

drop function if exists public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid);

create or replace function public.import_current_event_contact_first(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_registration_contact_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default null,p_import_issues jsonb default '[]'::jsonb,
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
      'price_origin',v_price_origin,'legacy_amount',v_source_amount));

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id),
    'price_origin',v_price_origin);
end; $$;

create or replace function public.resolve_import_batch_row_review(
  p_row_id uuid,p_decision text,p_registration_contact_id uuid default null,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_row public.import_batch_rows%rowtype; v_batch public.import_batches%rowtype;
  v_contact public.registration_contacts%rowtype; v_candidate_allowed boolean:=false;
  v_normalized jsonb; v_materialize jsonb; v_finalize jsonb; v_ticket_id uuid;
  v_has_pending_review boolean; v_cpf text; v_owner uuid; v_email text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_decision not in('link_existing','create_new','ignore','confirm_new_purchase','ignore_technical_duplicate',
    'confirm_excel_cpf','keep_pending_cpf','provide_alternate_cpf','assign_owner_contact','keep_people_separate') then
    raise exception 'Decisao de revisao invalida.';
  end if;
  select * into v_row from public.import_batch_rows where id=p_row_id for update;
  if not found then raise exception 'Linha de importacao nao encontrada.'; end if;
  select * into v_batch from public.import_batches where id=v_row.import_batch_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_batch.organization_id)
    or not public.resolve_user_permission(v_actor,'imports.view') then raise exception 'Sem permissao para revisar esta importacao.'; end if;

  if p_decision in('assign_owner_contact','keep_people_separate') then
    if not public.resolve_user_permission(v_actor,'participants.edit_basic') then
      raise exception 'Sem permissao para definir a conta proprietaria.';
    end if;
  end if;

  if p_decision='assign_owner_contact' then
    v_owner:=coalesce(p_registration_contact_id,nullif(p_payload->>'owner_registration_contact_id','')::uuid);
    if v_owner is null then raise exception 'Selecione a Pessoa dona da conta.'; end if;
    select * into v_contact from public.registration_contacts where id=v_owner and organization_id=v_batch.organization_id;
    if not found then raise exception 'Cadastro candidato invalido para esta organizacao.'; end if;
    v_email:=lower(trim(coalesce(v_row.normalized_data->>'email','')));
    update public.import_batch_rows r
      set intended_owner_contact_id=v_owner,review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),
          identity_match_details=coalesce(r.identity_match_details,'{}'::jsonb)||jsonb_build_object(
            'account_review_resolved','assign_owner_contact','intended_owner_contact_id',v_owner)
      where r.import_batch_id=v_batch.id
        and (r.id=v_row.id or (v_email<>'' and lower(trim(coalesce(r.normalized_data->>'email','')))=v_email));
    update public.order_items oi set intended_owner_contact_id=v_owner,updated_at=now()
      from public.import_batch_rows r
      where r.import_batch_id=v_batch.id and r.order_item_id=oi.id
        and (r.id=v_row.id or (v_email<>'' and lower(trim(coalesce(r.normalized_data->>'email','')))=v_email));
    update public.tickets t set intended_owner_contact_id=v_owner
      from public.import_batch_rows r
      where r.import_batch_id=v_batch.id and t.order_item_id=r.order_item_id and t.owner_user_id is null
        and (r.id=v_row.id or (v_email<>'' and lower(trim(coalesce(r.normalized_data->>'email','')))=v_email));
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_owner_contact_assigned','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,'owner_registration_contact_id',v_owner,
      'previous_intended_owner_contact_id',v_row.intended_owner_contact_id,'shared_email',nullif(v_email,'')));
    return jsonb_build_object('success',true,'changed',true,'status',v_row.status,'resolution',v_row.resolution,
      'intended_owner_contact_id',v_owner);
  end if;

  if p_decision='keep_people_separate' then
    v_email:=lower(trim(coalesce(v_row.normalized_data->>'email','')));
    update public.import_batch_rows r set review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),
      identity_match_details=coalesce(r.identity_match_details,'{}'::jsonb)||jsonb_build_object('account_review_resolved','keep_people_separate')
      where r.import_batch_id=v_batch.id
        and (r.id=v_row.id or (v_email<>'' and lower(trim(coalesce(r.normalized_data->>'email','')))=v_email));
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_people_kept_separate','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id));
    return jsonb_build_object('success',true,'changed',true,'status',v_row.status,'resolution',v_row.resolution);
  end if;

  if v_row.status<>'review_required' or v_row.resolution<>'pending' then
    return jsonb_build_object('success',true,'changed',false,'status',v_row.status,'resolution',v_row.resolution);
  end if;

  v_normalized:=coalesce(v_row.normalized_data,'{}'::jsonb);

  if p_decision='ignore' or p_decision='ignore_technical_duplicate' then
    update public.import_batch_rows set status='skipped',resolution='ignore',review_decision=p_decision,
      reviewed_by=v_actor,reviewed_at=now(),updated_at=now() where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values(case when p_decision='ignore_technical_duplicate' then 'import_technical_duplicate_ignored' else 'import_row_review_resolved' end,
      'import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object('actor_user_id',v_actor,'import_batch_id',v_batch.id,'decision',p_decision));
    select exists(
      select 1 from public.import_batch_rows r where r.import_batch_id=v_batch.id and r.status='review_required' and r.resolution='pending'
    ) into v_has_pending_review;
    update public.import_batches b set
      imported_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='imported'),
      error_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='error'),
      skipped_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('duplicate','skipped')),
      status=case
        when v_has_pending_review then 'ready_for_review'
        when exists(select 1 from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('ready','data_pending'))
          then case when b.status in('completed','failed','cancelled') then b.status else 'processing' end
        else 'completed'
      end,
      completed_at=case
        when v_has_pending_review then null
        when exists(select 1 from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('ready','data_pending')) then b.completed_at
        else coalesce(b.completed_at,now())
      end
    where b.id=v_batch.id;
    return jsonb_build_object('success',true,'changed',true,'status','skipped','resolution','ignore');
  end if;

  if p_decision='confirm_excel_cpf' then
    v_cpf:=coalesce(nullif(trim(p_payload->>'cpf'),''),v_row.cpf_excel_candidate,v_normalized->'excel_cpf'->>'suggested');
    if not public.is_valid_cpf(v_cpf) then raise exception 'CPF sugerido invalido.'; end if;
    v_normalized:=v_normalized||jsonb_build_object('cpf',regexp_replace(v_cpf,'\D','','g'),'cpf_input',regexp_replace(v_cpf,'\D','','g'));
    update public.import_batch_rows set normalized_data=v_normalized,status='ready',resolution='create_new',
      review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),error_message=null,
      data_issues=coalesce((
        select jsonb_agg(issue) from jsonb_array_elements(coalesce(v_row.data_issues,'[]'::jsonb)) issue
        where issue->>'field_code' is distinct from 'cpf'
      ),'[]'::jsonb)
      where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_excel_cpf_confirmed','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,
      'original_digits',coalesce(v_row.normalized_data->>'cpf_raw',v_row.normalized_data->>'cpf_input'),
      'suggested_cpf',v_row.cpf_excel_candidate,
      'confirmed_cpf',regexp_replace(v_cpf,'\D','','g')));
  elsif p_decision='provide_alternate_cpf' then
    v_cpf:=nullif(trim(p_payload->>'cpf'),'');
    if not public.is_valid_cpf(v_cpf) then raise exception 'Informe um CPF valido.'; end if;
    v_normalized:=v_normalized||jsonb_build_object('cpf',regexp_replace(v_cpf,'\D','','g'),'cpf_input',regexp_replace(v_cpf,'\D','','g'));
    update public.import_batch_rows set normalized_data=v_normalized,status='ready',resolution='create_new',
      review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),error_message=null,
      data_issues=coalesce((
        select jsonb_agg(issue) from jsonb_array_elements(coalesce(v_row.data_issues,'[]'::jsonb)) issue
        where issue->>'field_code' is distinct from 'cpf'
      ),'[]'::jsonb) where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_excel_cpf_overridden','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,'confirmed_cpf',regexp_replace(v_cpf,'\D','','g')));
  elsif p_decision='keep_pending_cpf' then
    update public.import_batch_rows set status='data_pending',resolution='create_new',review_decision=p_decision,
      reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),
      error_message='CPF pendente. Compra sera preservada sem identidade confiavel.'
      where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_cpf_kept_pending','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id));
  elsif p_decision='confirm_new_purchase' then
    update public.import_batch_rows set status='ready',resolution='create_new',review_decision=p_decision,
      reviewed_by=v_actor,reviewed_at=now(),updated_at=now(),error_message='Nova compra confirmada pelo administrador.'
      where id=v_row.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_new_purchase_confirmed','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'import_batch_id',v_batch.id,'previous_import_batch_row_id',v_row.possible_reimport_of_row_id));
  elsif p_decision='link_existing' then
    if p_registration_contact_id is null then raise exception 'Selecione o cadastro candidato.'; end if;
    select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_batch.organization_id;
    if not found then raise exception 'Cadastro candidato invalido para esta organizacao.'; end if;
    select exists(
      select 1 from jsonb_array_elements(coalesce(v_row.identity_match_details->'candidates','[]'::jsonb)) c
      where c->>'registration_contact_id'=p_registration_contact_id::text
    ) or v_row.registration_contact_id=p_registration_contact_id into v_candidate_allowed;
    if not v_candidate_allowed then raise exception 'Cadastro nao consta entre os candidatos auditados desta linha.'; end if;
  end if;

  select * into v_row from public.import_batch_rows where id=p_row_id;
  v_normalized:=coalesce(v_row.normalized_data,'{}'::jsonb);

  if p_decision in('link_existing','create_new') and v_batch.import_type='current_event_registrations' then
    if v_batch.imported_by<>v_actor then
      raise exception 'Apenas o operador original do lote pode concluir esta revisao.';
    end if;
    v_materialize:=public.import_current_event_contact_first(
      p_import_batch_id:=v_batch.id,
      p_import_batch_row_id:=v_row.id,
      p_expected_registration_contact_id:=case when p_decision='link_existing' then p_registration_contact_id else null end,
      p_full_name:=nullif(trim(coalesce(v_normalized->>'full_name','')),''),
      p_cpf:=coalesce(nullif(trim(v_normalized->>'cpf_input'),''),nullif(trim(v_normalized->>'cpf'),'')),
      p_birth_date:=nullif(v_normalized->>'birth_date','')::date,
      p_gender:=nullif(v_normalized->>'gender',''),
      p_phone:=nullif(v_normalized->>'phone',''),
      p_email:=nullif(v_normalized->>'email',''),
      p_city:=nullif(v_normalized->>'city',''),
      p_shirt_type:=nullif(v_normalized->>'shirt_type',''),
      p_shirt_size:=nullif(v_normalized->>'shirt_size',''),
      p_registration_batch_id:=nullif(v_normalized->>'resolved_batch_id','')::uuid,
      p_ticket_category_id:=nullif(v_normalized->>'resolved_category_id','')::uuid,
      p_payment_method:=nullif(btrim(coalesce(v_normalized->>'payment_method','')),''),
      p_import_issues:=coalesce(v_row.data_issues,'[]'::jsonb),
      p_assign_holder:=true,
      p_intended_owner_contact_id:=v_row.intended_owner_contact_id
    );
    if (v_materialize->>'order_item_id') is null then raise exception 'Falha ao materializar a linha revisada.'; end if;
    if coalesce((v_materialize->>'has_issuance_blockers')::boolean,false)=false
       and coalesce(v_batch.payment_mode_original,'pending')='confirm_all' then
      v_finalize:=public.finalize_imported_ticket_after_issue_resolution((v_materialize->>'order_item_id')::uuid,array[]::text[]);
      v_ticket_id:=nullif(v_finalize->>'ticket_id','')::uuid;
    end if;
    update public.import_batch_rows set status='imported',resolution=p_decision,error_message=null,
      ticket_id=coalesce(v_ticket_id,ticket_id),review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
      where id=v_row.id;
  elsif p_decision in('link_existing','create_new') then
    if p_decision='link_existing' then
      update public.import_batch_rows set resolution='link_existing',registration_contact_id=v_contact.id,
        matched_user_id=v_contact.user_id,review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
        where id=v_row.id;
    else
      update public.import_batch_rows set resolution='create_new',registration_contact_id=null,matched_participant_id=null,
        matched_user_id=null,review_decision=p_decision,reviewed_by=v_actor,reviewed_at=now(),updated_at=now()
        where id=v_row.id;
    end if;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('import_row_review_resolved','import_batch_rows',v_row.id,v_batch.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'import_batch_id',v_batch.id,'decision',p_decision,
    'registration_contact_id',coalesce(v_materialize->>'registration_contact_id',p_registration_contact_id::text),
    'order_item_id',v_materialize->>'order_item_id','ticket_id',v_ticket_id));

  select exists(
    select 1 from public.import_batch_rows r where r.import_batch_id=v_batch.id and r.status='review_required' and r.resolution='pending'
  ) into v_has_pending_review;
  update public.import_batches b set
    imported_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='imported'),
    error_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='error'),
    skipped_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('duplicate','skipped')),
    status=case
      when v_has_pending_review then 'ready_for_review'
      when exists(select 1 from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('ready','data_pending'))
        then case when b.status in('completed','failed','cancelled') then b.status else 'processing' end
      else 'completed'
    end,
    completed_at=case
      when v_has_pending_review then null
      when exists(select 1 from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('ready','data_pending')) then b.completed_at
      else coalesce(b.completed_at,now())
    end
  where b.id=v_batch.id;

  return jsonb_build_object('success',true,'changed',true,
    'status',case
      when p_decision in('ignore','ignore_technical_duplicate') then 'skipped'
      when p_decision in('link_existing','create_new') and v_batch.import_type='current_event_registrations' then 'imported'
      else coalesce((select status from public.import_batch_rows where id=v_row.id),v_row.status)
    end,
    'resolution',p_decision,
    'registration_contact_id',v_materialize->>'registration_contact_id',
    'participant_id',v_materialize->>'participant_id',
    'order_id',v_materialize->>'order_id',
    'payment_id',v_materialize->>'payment_id',
    'order_item_id',v_materialize->>'order_item_id',
    'ticket_id',v_ticket_id);
end; $$;

-- Repair: only this pilot, only rows whose CSV payment_method was empty,
-- only placeholder pending payments with price_origin=legacy_unknown and no Asaas charge.
-- Row 365 (Pix in source) is excluded by the empty-method predicate.

update public.payments p
set payment_method = null, updated_at = now()
from public.import_batch_rows r
join public.import_batches b on b.id = r.import_batch_id
join public.order_items oi on oi.id = r.order_item_id
where p.order_id = oi.order_id
  and b.source_file_hash = 'e0e3602c09c3d9b8ab009b58cc8701389b4538b9640241312a8d346af685365e'
  and coalesce(p.price_origin, '') = 'legacy_unknown'
  and p.payment_status = 'pending'
  and p.gateway_payment_id is null
  and coalesce(p.provider, '') = ''
  and p.payment_method = 'pix'
  and nullif(btrim(coalesce(r.normalized_data->>'payment_method','')), '') is null;

-- Shared email 208/209: keep audit, stop identity-merge queue after distinct people materialized.
update public.import_batch_rows r
set identity_match_details = coalesce(r.identity_match_details, '{}'::jsonb)
  || jsonb_build_object('account_review_resolved', 'materialized_distinct_identities'),
    updated_at = now()
from public.import_batches b
where r.import_batch_id = b.id
  and b.source_file_hash = 'e0e3602c09c3d9b8ab009b58cc8701389b4538b9640241312a8d346af685365e'
  and r.status = 'imported'
  and r.identity_match_details->>'account_review' = 'shared_email'
  and nullif(r.identity_match_details->>'account_review_resolved', '') is null;

grant execute on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid) to authenticated, service_role;
grant execute on function public.resolve_import_batch_row_review(uuid,text,uuid,jsonb) to authenticated, service_role;
