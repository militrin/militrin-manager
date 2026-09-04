-- Importacao real Militrin: compras adicionais da mesma Pessoa, ownership
-- pre-claim, CPF pendente, fingerprint de compra e titular so quando assigned.
begin;

alter table public.import_batches
  add column if not exists source_file_hash text;

alter table public.import_batch_rows
  add column if not exists row_fingerprint text,
  add column if not exists occurrence_index integer not null default 1,
  add column if not exists source_file_hash text,
  add column if not exists external_purchase_key text,
  add column if not exists intended_owner_contact_id uuid references public.registration_contacts(id) on delete set null,
  add column if not exists possible_reimport_of_row_id uuid references public.import_batch_rows(id) on delete set null,
  add column if not exists cpf_excel_candidate text,
  add column if not exists cpf_cell_kind text;

alter table public.order_items
  add column if not exists intended_owner_contact_id uuid references public.registration_contacts(id) on delete set null;

alter table public.tickets
  add column if not exists intended_owner_contact_id uuid references public.registration_contacts(id) on delete set null;

create index if not exists idx_import_batches_org_event_file_hash
  on public.import_batches(organization_id, event_id, source_file_hash)
  where source_file_hash is not null;

create unique index if not exists ux_import_batch_rows_purchase_occurrence
  on public.import_batch_rows(import_batch_id, row_fingerprint, occurrence_index)
  where row_fingerprint is not null;

create index if not exists idx_import_batch_rows_fingerprint
  on public.import_batch_rows(row_fingerprint)
  where row_fingerprint is not null;

create index if not exists idx_tickets_intended_owner_contact
  on public.tickets(intended_owner_contact_id)
  where intended_owner_contact_id is not null;

create index if not exists idx_order_items_intended_owner_contact
  on public.order_items(intended_owner_contact_id)
  where intended_owner_contact_id is not null;

alter table public.import_batch_rows drop constraint if exists import_batch_rows_review_decision_check;
alter table public.import_batch_rows add constraint import_batch_rows_review_decision_check
  check(review_decision is null or review_decision in(
    'link_existing','create_new','ignore',
    'confirm_new_purchase','ignore_technical_duplicate',
    'confirm_excel_cpf','keep_pending_cpf','provide_alternate_cpf',
    'assign_owner_contact','keep_people_separate'
  ));

-- Titular ativo = item assigned. registration_contact_id em item unassigned
-- e o vinculo comercial da Pessoa/compra, nao titularidade.
create or replace function public.registration_contact_has_active_ticket(
  p_event_id uuid, p_registration_contact_id uuid, p_exclude_ticket_id uuid default null
) returns boolean language sql security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from public.tickets t
    left join public.order_items oi on oi.id=t.order_item_id
    left join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
    where t.event_id=p_event_id and t.id is distinct from p_exclude_ticket_id
      and t.status not in('cancelled','canceled','void','voided')
      and coalesce(oi.ownership_status,'unassigned')='assigned'
      and coalesce(oi.registration_contact_id,p.registration_contact_id)=p_registration_contact_id
  );
$$;

create or replace function public.detect_integrity_duplicate_active_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path=public,pg_temp as $$
  with active_holders as (
    select
      coalesce(oi.registration_contact_id, p.registration_contact_id) as contact_id,
      t.event_id, t.id as ticket_id
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    left join public.participants p on p.id = coalesce(oi.participant_id, t.participant_id)
    where t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and coalesce(oi.ownership_status,'unassigned') = 'assigned'
      and coalesce(oi.registration_contact_id, p.registration_contact_id) is not null
      and t.organization_id = p_organization_id
      and (p_event_id is null or t.event_id = p_event_id)
  ),
  conflicts as (
    select contact_id, event_id, count(*) as ticket_count
    from active_holders group by contact_id, event_id having count(*) > 1
  )
  select
    'DUPLICATE_ACTIVE_HOLDER'::text, 'critical'::text, 'titularidade'::text,
    'Titular duplicado no mesmo evento'::text,
    'Esta pessoa aparece como titular de mais de um ingresso ativo no mesmo evento.'::text,
    ah.event_id, 'ticket'::text, ah.ticket_id,
    'Abrir ingresso'::text, '/ingressos/' || ah.ticket_id,
    jsonb_build_object('registration_contact_id', ah.contact_id, 'ticket_count', c.ticket_count)
  from active_holders ah
  join conflicts c on c.contact_id = ah.contact_id and c.event_id = ah.event_id;
$$;

create or replace function public.trg_enforce_ticket_holder_contact_uniqueness()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_contact uuid; v_ticket_id uuid; v_event_id uuid; v_identity_unchanged boolean; v_reactivating boolean;
  v_will_conflict boolean; v_ownership text;
begin
  if tg_table_name='tickets' then
    v_ticket_id:=new.id; v_event_id:=new.event_id;
    if tg_op='INSERT' and new.order_item_id is not null then
      select exists(select 1 from public.tickets where order_item_id=new.order_item_id) into v_will_conflict;
      if v_will_conflict then return new; end if;
    end if;
    if new.status in ('cancelled','canceled','void','voided') then return new; end if;
    if tg_op='UPDATE' then
      v_identity_unchanged := new.participant_id is not distinct from old.participant_id
        and new.order_item_id is not distinct from old.order_item_id;
      v_reactivating := old.status in ('cancelled','canceled','void','voided');
      if v_identity_unchanged and not v_reactivating then return new; end if;
    end if;
    select registration_contact_id into v_contact from public.participants where id=new.participant_id;
    if new.order_item_id is not null then
      select case when coalesce(oi.ownership_status,'unassigned')='assigned'
        then coalesce(v_contact,oi.registration_contact_id,p.registration_contact_id) end
        into v_contact
      from public.order_items oi left join public.participants p on p.id=oi.participant_id where oi.id=new.order_item_id;
    end if;
  else
    select t.id,t.event_id into v_ticket_id,v_event_id from public.tickets t where t.order_item_id=new.id;
    if v_ticket_id is null then return new; end if;
    v_ownership:=coalesce(new.ownership_status,'unassigned');
    if v_ownership is distinct from 'assigned' then return new; end if;
    if new.participant_id is not null then
      select registration_contact_id into v_contact from public.participants where id=new.participant_id;
      new.registration_contact_id:=coalesce(v_contact,new.registration_contact_id);
    else
      v_contact:=new.registration_contact_id;
    end if;
  end if;
  perform public.assert_ticket_holder_contact_available(v_ticket_id,v_event_id,v_contact);
  return new;
end; $$;

create or replace function public.trg_ticket_copy_intended_owner()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.intended_owner_contact_id is null and new.order_item_id is not null then
    select coalesce(oi.intended_owner_contact_id, oi.registration_contact_id)
      into new.intended_owner_contact_id
    from public.order_items oi where oi.id=new.order_item_id;
  end if;
  return new;
end; $$;

drop trigger if exists trg_ticket_copy_intended_owner on public.tickets;
create trigger trg_ticket_copy_intended_owner
before insert or update of order_item_id, intended_owner_contact_id on public.tickets
for each row execute function public.trg_ticket_copy_intended_owner();

drop function if exists public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean);

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

  if p_registration_batch_id is not null and p_ticket_category_id is not null then
    select case when lower(coalesce(p_gender,''))='female' then female_price else male_price end into v_amount
    from public.registration_batch_prices where batch_id=p_registration_batch_id and ticket_category_id=p_ticket_category_id;
  end if;
  v_amount:=coalesce(v_amount,0);

  if v_assign_holder and exists(
    select 1 from public.order_items oi
    where oi.event_id=v_event.id and oi.registration_contact_id=v_contact.id
      and coalesce(oi.ownership_status,'unassigned')='assigned'
      and oi.status not in('cancelled','expired','refunded')
  ) then v_assign_holder:=false; end if;

  insert into public.payments(participant_id,event_id,organization_id,amount,discount_amount,final_amount,payment_method,payment_status)
  values(v_participant.id,v_event.id,v_event.organization_id,v_amount,0,v_amount,coalesce(nullif(trim(p_payment_method),''),'pix'),'pending') returning * into v_payment;
  insert into public.orders(user_id,participant_id,event_id,organization_id,payment_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,import_batch_id)
  values(null,v_participant.id,v_event.id,v_event.organization_id,v_payment.id,public.generate_order_number(),'pending',v_amount,0,v_amount,'imported_holder',v_batch.id) returning * into v_order;
  update public.payments set order_id=v_order.id where id=v_payment.id;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,intended_owner_contact_id,ownership_status,holder_full_name,
    ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status)
  values(v_order.id,v_event.id,case when v_assign_holder then v_participant.id end,v_contact.id,v_intended,
    case when v_assign_holder then 'assigned' else 'unassigned' end,case when v_assign_holder then v_contact.full_name end,
    p_ticket_category_id,p_registration_batch_id,nullif(trim(p_shirt_type),''),nullif(upper(trim(p_shirt_size)),''),1,v_amount,0,v_amount,'reserved') returning * into v_item;

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
      'holder_assigned',v_assign_holder,'intended_owner_contact_id',v_intended,'shirt_type',p_shirt_type,'shirt_size',p_shirt_size));

  return jsonb_build_object('registration_contact_id',v_contact.id,'participant_id',v_participant.id,
    'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,'ticket_id',v_ticket_id,
    'created_contact',v_created_contact,'created_participant_projection',v_created_participant,'holder_assigned',v_assign_holder,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_participant.id));
end; $$;

drop function if exists public.resolve_import_batch_row_review(uuid,text,uuid);
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
      p_payment_method:=coalesce(nullif(v_normalized->>'payment_method',''),'pix'),
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

create or replace function public.assign_imported_ticket_owner_contact(
  p_order_item_ids uuid[], p_owner_registration_contact_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_contact public.registration_contacts%rowtype; v_count integer:=0;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('imports.view')
    or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para definir a conta proprietaria.';
  end if;
  if p_owner_registration_contact_id is null then raise exception 'Pessoa dona da conta obrigatoria.'; end if;
  select * into v_contact from public.registration_contacts where id=p_owner_registration_contact_id;
  if not found or not public.user_can_access_organization(v_actor,v_contact.organization_id) then
    raise exception 'Cadastro invalido ou sem acesso.';
  end if;
  update public.order_items oi set intended_owner_contact_id=v_contact.id,updated_at=now()
    from public.orders o
    where oi.id=any(p_order_item_ids) and o.id=oi.order_id and o.organization_id=v_contact.organization_id;
  get diagnostics v_count=row_count;
  update public.tickets t set intended_owner_contact_id=v_contact.id
    where t.order_item_id=any(p_order_item_ids) and t.organization_id=v_contact.organization_id and t.owner_user_id is null;
  update public.import_batch_rows set intended_owner_contact_id=v_contact.id,updated_at=now()
    where order_item_id=any(p_order_item_ids);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('import_owner_contact_assigned','registration_contacts',v_contact.id,null,jsonb_build_object(
    'actor_user_id',v_actor,'owner_registration_contact_id',v_contact.id,'order_item_ids',to_jsonb(p_order_item_ids),'updated_items',v_count));
  return jsonb_build_object('success',true,'updated',v_count,'owner_registration_contact_id',v_contact.id);
end; $$;

create or replace function public.materialize_intended_ticket_owners_for_contact(p_contact_id uuid, p_user_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer:=0;
begin
  if p_contact_id is null or p_user_id is null then return 0; end if;
  with owned as (
    update public.tickets t
    set owner_user_id=p_user_id
    where t.intended_owner_contact_id=p_contact_id
      and t.owner_user_id is null
      and t.status not in('cancelled','canceled','void','voided')
    returning t.id,t.order_id,t.event_id,t.organization_id
  ), history as (
    insert into public.ticket_owner_history(ticket_id,order_id,event_id,organization_id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text)
    select owned.id,owned.order_id,owned.event_id,owned.organization_id,'owner_assigned',null,p_user_id,p_user_id,'data_regularization',
      'Propriedade materializada a partir da intencao de owner da importacao.'
    from owned
    returning ticket_id
  )
  select count(*)::integer into v_count from history;
  return v_count;
end; $$;

create or replace function public.trg_reconcile_contact_account()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if pg_trigger_depth()>1 or new.user_id is null then return new; end if;
  if tg_op='UPDATE' and new.user_id is not distinct from old.user_id then return new; end if;
  perform public.reconcile_registration_contact_account(new.id,new.user_id);
  perform public.materialize_intended_ticket_owners_for_contact(new.id,new.user_id);
  return new;
end; $$;

create or replace function public.check_registration_contact_account_invite_eligibility(
  p_registration_contact_id uuid
)
returns table(eligible boolean, reason_code text, reason_message text, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_email text;
  v_cpf text;
  v_auth_count integer;
  v_auth_user auth.users%rowtype;
  v_inv public.participant_account_invites%rowtype;
  v_profile_cpf text;
  v_shared integer;
  v_other_intended integer;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;

  select rc.* into v_contact
  from public.registration_contacts rc
  where rc.id = p_registration_contact_id;

  if not found or not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    return query select false, 'inaccessible', 'Cadastro invalido ou sem acesso.', null::text;
    return;
  end if;
  if v_contact.user_id is not null then
    return query select false, 'already_linked', 'Conta ja vinculada.', null::text;
    return;
  end if;
  if nullif(trim(coalesce(v_contact.email, '')), '') is null then
    return query select false, 'missing_email', 'Sem e-mail.', null::text;
    return;
  end if;

  v_email := lower(trim(v_contact.email));
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select false, 'invalid_email', 'E-mail invalido.', v_email;
    return;
  end if;

  select count(*) into v_shared
  from public.registration_contacts other
  where other.organization_id = v_contact.organization_id
    and other.id <> v_contact.id
    and lower(trim(coalesce(other.email, ''))) = v_email;

  if v_shared > 0 then
    select count(*) into v_other_intended
    from public.tickets t
    where t.intended_owner_contact_id is not null
      and t.intended_owner_contact_id <> v_contact.id
      and t.status not in ('cancelled','canceled','void','voided')
      and t.intended_owner_contact_id in (
        select other.id from public.registration_contacts other
        where other.organization_id = v_contact.organization_id
          and other.id <> v_contact.id
          and lower(trim(coalesce(other.email, ''))) = v_email
      );
    if v_other_intended > 0 then
      return query select false, 'email_conflict', 'E-mail compartilhado. Outra Pessoa ja e a conta proprietaria destes ingressos.', v_email;
      return;
    end if;
    if not exists (
      select 1 from public.tickets t
      where t.intended_owner_contact_id = v_contact.id
        and t.status not in ('cancelled','canceled','void','voided')
    ) and not exists (
      select 1 from public.order_items oi
      where oi.intended_owner_contact_id = v_contact.id
        and oi.status not in ('cancelled','expired','refunded')
    ) then
      return query select false, 'email_conflict', 'E-mail compartilhado. Escolha a Pessoa dona da conta na revisao de importacao.', v_email;
      return;
    end if;
  end if;

  if public.is_valid_cpf(v_contact.cpf) then
    v_cpf := regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g');
    if exists (
      select 1 from public.registration_contacts other
      where other.organization_id = v_contact.organization_id
        and other.id <> v_contact.id
        and regexp_replace(coalesce(other.cpf, ''), '\D', '', 'g') = v_cpf
    ) then
      return query select false, 'cpf_conflict', 'CPF em conflito com outra Pessoa.', v_email;
      return;
    end if;
  end if;

  select count(*) into v_auth_count
  from auth.users au
  where lower(trim(coalesce(au.email, ''))) = v_email;
  if v_auth_count = 0 then
    return query select true, 'eligible', 'Cadastro apto para convite.', v_email;
    return;
  end if;
  if v_auth_count <> 1 then
    return query select false, 'email_conflict', 'E-mail em conflito com outra conta.', v_email;
    return;
  end if;
  select au.* into strict v_auth_user
  from auth.users au
  where lower(trim(coalesce(au.email, ''))) = v_email;

  select pai.* into v_inv
  from public.participant_account_invites pai
  where pai.registration_contact_id = v_contact.id
    and lower(trim(pai.email)) = v_email
    and pai.status = 'pending'
    and (
      pai.auth_user_id = v_auth_user.id
      or (pai.auth_user_id is null
        and v_auth_user.raw_user_meta_data->>'participant_invite_id' = pai.id::text)
    )
  order by pai.created_at desc
  limit 1;
  if not found then
    return query select false, 'email_conflict', 'E-mail em conflito com outra conta.', v_email;
    return;
  end if;

  select regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g') into v_profile_cpf
  from public.customer_profiles cp
  where cp.user_id = v_auth_user.id;
  if nullif(v_profile_cpf, '') is not null and public.is_valid_cpf(v_contact.cpf)
    and v_profile_cpf <> regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g') then
    return query select false, 'cpf_conflict', 'CPF em conflito com a conta deste e-mail.', v_email;
    return;
  end if;

  return query select true, 'resend_invite_existing_account', 'Convite pendente pode ser reenviado.', v_email;
end;
$$;

create or replace function public.update_registration_contact_from_participant(
  p_participant_id uuid,p_values jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype;
  v_key text; v_allowed constant text[]:=array['full_name','cpf','birth_date','gender','phone','email','city'];
  v_new_cpf text; v_collision uuid;
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
  if p_values?'cpf' and nullif(p_values->>'cpf','') is not null then
    v_new_cpf:=regexp_replace(p_values->>'cpf','\D','','g');
    select rc.id into v_collision from public.registration_contacts rc
      where rc.organization_id=v_participant.organization_id
        and rc.id<>v_participant.registration_contact_id
        and regexp_replace(coalesce(rc.cpf,''),'\D','','g')=v_new_cpf
      limit 1;
    if v_collision is not null then
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      values('import_cpf_collision','registration_contacts',v_participant.registration_contact_id,v_participant.event_id,
        jsonb_build_object('actor_user_id',v_actor,'conflicting_registration_contact_id',v_collision,'cpf_suffix',right(v_new_cpf,2)));
      raise exception using errcode='P0001', message='CPF_COLLISION_REQUIRES_ADMIN',
        detail=jsonb_build_object('code','CPF_COLLISION_REQUIRES_ADMIN',
          'message','Este CPF ja identifica outra Pessoa. A organizacao precisa revisar antes de ativar a conta.')::text;
    end if;
  end if;
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

  update public.participants p set
    full_name=v_contact.full_name, cpf=v_contact.cpf, birth_date=v_contact.birth_date, gender=v_contact.gender,
    phone=v_contact.phone, email=v_contact.email, city=v_contact.city, updated_at=now()
  where p.id=v_participant.id;

  perform public.reevaluate_participant_data_issues(v_participant.id);

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('registration_contact_personal_data_updated','registration_contacts',v_contact.id,v_participant.event_id,
    jsonb_build_object('actor_user_id',v_actor,'participant_projection_id',v_participant.id,'fields_updated',
      (select coalesce(jsonb_agg(k),'[]'::jsonb) from jsonb_object_keys(coalesce(p_values,'{}'::jsonb)) k),
      'cpf_corrected_on_first_access', p_values?'cpf' and v_actor=v_participant.user_id));
  return jsonb_build_object('success',true,'registration_contact_id',v_contact.id);
end; $$;

revoke all on function public.materialize_intended_ticket_owners_for_contact(uuid,uuid) from public, anon, authenticated;
grant execute on function public.materialize_intended_ticket_owners_for_contact(uuid,uuid) to service_role;

revoke all on function public.assign_imported_ticket_owner_contact(uuid[],uuid) from public, anon;
grant execute on function public.assign_imported_ticket_owner_contact(uuid[],uuid) to authenticated, service_role;

revoke all on function public.resolve_import_batch_row_review(uuid,text,uuid,jsonb) from public, anon;
grant execute on function public.resolve_import_batch_row_review(uuid,text,uuid,jsonb) to authenticated, service_role;

revoke all on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid) from public, anon;
grant execute on function public.import_current_event_contact_first(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb,boolean,uuid) to authenticated, service_role;

create or replace function public.trg_protect_intended_owner_contact()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.intended_owner_contact_id is distinct from old.intended_owner_contact_id then
    if auth.uid() is null then return new; end if;
    if not public.current_user_has_permission('imports.view') then
      raise exception 'Sem permissao para alterar a intencao de proprietario.';
    end if;
    if tg_table_name in ('tickets','order_items')
      and not public.current_user_has_permission('participants.edit_basic') then
      raise exception 'Sem permissao para alterar a intencao de proprietario.';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_protect_tickets_intended_owner on public.tickets;
create trigger trg_protect_tickets_intended_owner
before update of intended_owner_contact_id on public.tickets
for each row execute function public.trg_protect_intended_owner_contact();

drop trigger if exists trg_protect_order_items_intended_owner on public.order_items;
create trigger trg_protect_order_items_intended_owner
before update of intended_owner_contact_id on public.order_items
for each row execute function public.trg_protect_intended_owner_contact();

drop trigger if exists trg_protect_import_rows_intended_owner on public.import_batch_rows;
create trigger trg_protect_import_rows_intended_owner
before update of intended_owner_contact_id on public.import_batch_rows
for each row execute function public.trg_protect_intended_owner_contact();

drop function if exists public.assert_registration_contact_cpf_available(uuid,text);
create function public.assert_registration_contact_cpf_available(
  p_registration_contact_id uuid, p_cpf text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_cpf text:=regexp_replace(coalesce(p_cpf,''),'\D','','g');
  v_collision uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_registration_contact_id is null then raise exception 'Cadastro obrigatorio.'; end if;
  if not public.is_valid_cpf(v_cpf) then raise exception 'CPF invalido.'; end if;
  select * into v_contact from public.registration_contacts where id=p_registration_contact_id;
  if not found then raise exception 'Cadastro invalido.'; end if;
  if v_contact.user_id is distinct from v_actor
    and not exists (
      select 1 from public.participant_account_invites pai
      where pai.registration_contact_id=v_contact.id
        and pai.auth_user_id=v_actor
        and pai.status in ('pending','claimed')
    )
    and not (
      public.user_can_access_organization(v_actor,v_contact.organization_id)
      and public.resolve_user_permission(v_actor,'participants.edit_basic')
    )
  then
    raise exception 'Sem permissao.';
  end if;
  select rc.id into v_collision
    from public.registration_contacts rc
    where rc.organization_id=v_contact.organization_id
      and rc.id<>v_contact.id
      and regexp_replace(coalesce(rc.cpf,''),'\D','','g')=v_cpf
    limit 1;
  if v_collision is not null then
    -- Retorno (nao RAISE): o INSERT de auditoria precisa commitar. RAISE
    -- dentro da mesma RPC faria o PostgREST desfazer o audit_logs.
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('import_cpf_collision','registration_contacts',v_contact.id,null,jsonb_build_object(
      'actor_user_id',v_actor,'conflicting_registration_contact_id',v_collision,'cpf_suffix',right(v_cpf,2),
      'stage','first_access_preclaim'));
    return jsonb_build_object(
      'ok', false,
      'code', 'CPF_COLLISION_REQUIRES_ADMIN',
      'message', 'Este CPF ja identifica outra Pessoa. A organizacao precisa revisar antes de ativar a conta.',
      'conflicting_registration_contact_id', v_collision
    );
  end if;
  return jsonb_build_object('ok', true);
end; $$;

revoke all on function public.assert_registration_contact_cpf_available(uuid,text) from public, anon;
grant execute on function public.assert_registration_contact_cpf_available(uuid,text) to authenticated, service_role;

commit;
