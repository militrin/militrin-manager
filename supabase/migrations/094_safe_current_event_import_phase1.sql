-- 094_safe_current_event_import_phase1.sql
-- Identidade por CPF+evento, pendencias deterministicas e upsert idempotente do importador.

begin;

alter table public.participants alter column phone drop not null;
alter table public.participants drop constraint if exists participants_email_required_chk;

alter table public.participant_data_issues
  drop constraint if exists participant_data_issues_active_unique;
create unique index if not exists ux_participant_data_issues_open
  on public.participant_data_issues(
    participant_id,
    coalesce(import_batch_id,'00000000-0000-0000-0000-000000000000'::uuid),
    field_code,
    issue_type
  ) where status='open';

create or replace function public.is_valid_cpf(p_value text) returns boolean
language plpgsql immutable set search_path=public,pg_temp as $$
declare v text:=regexp_replace(coalesce(p_value,''),'\D','','g'); v_sum integer; v_digit integer;
begin
  if v !~ '^\d{11}$' or v ~ '^(\d)\1{10}$' then return false; end if;
  v_sum:=0; for i in 1..9 loop v_sum:=v_sum+substring(v,i,1)::integer*(11-i); end loop;
  v_digit:=(v_sum*10)%11; if v_digit=10 then v_digit:=0; end if;
  if v_digit<>substring(v,10,1)::integer then return false; end if;
  v_sum:=0; for i in 1..10 loop v_sum:=v_sum+substring(v,i,1)::integer*(12-i); end loop;
  v_digit:=(v_sum*10)%11; if v_digit=10 then v_digit:=0; end if;
  return v_digit=substring(v,11,1)::integer;
end; $$;

create or replace function public.reevaluate_participant_data_issues(
  p_participant_id uuid,p_import_batch_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_e public.events%rowtype;
  v_price public.registration_batch_prices%rowtype; v_gender text; v_base numeric;
  v_age integer; v_open integer; v_issue record;
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

  if v_p.batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_p.batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_p.ticket_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_p.ticket_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_p.batch_id is not null and v_p.ticket_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_p.batch_id and ticket_category_id=v_p.ticket_category_id;
    if not found then
      insert into pg_temp.expected_import_issues values('price','unresolved','Preco nao encontrado para lote e categoria.',true,true,false,false);
    end if;
  end if;

  v_gender:=lower(trim(coalesce(v_p.gender,'')));
  if v_price.id is not null and v_price.male_price is distinct from v_price.female_price
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
    and i.field_code in('cpf','email','phone','birth_date','event_date','batch','category','price','gender','shirt_selection')
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
      update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
      where participant_id=v_p.id and payment_status<>'paid';
      if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
        insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
        values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
      end if;
    end if;
  end if;

  select count(*) into v_open from public.participant_data_issues where participant_id=v_p.id and status='open';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('participant_data_issues_reevaluated','participants',v_p.id,v_e.id,
    jsonb_build_object('actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'open_issue_count',v_open,'source',case when p_import_batch_id is null then 'edit' else 'import' end));
  return jsonb_build_object('participant_id',v_p.id,'open_issue_count',v_open,'price_defined',v_base is not null);
end; $$;

create or replace function public.import_participant_has_issuance_blockers(p_participant_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.participant_data_issues
    where participant_id=p_participant_id and status='open'
      and (blocks_payment or blocks_ticket_issuance));
$$;

create or replace function public.upsert_current_event_import_participant(
  p_import_batch_id uuid,p_import_batch_row_id uuid,p_expected_participant_id uuid,
  p_full_name text,p_cpf text,p_birth_date date,p_gender text,p_phone text,p_email text,p_city text,
  p_shirt_type text,p_shirt_size text,p_registration_batch_id uuid,p_ticket_category_id uuid,
  p_payment_method text default 'pix',p_import_issues jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_batch public.import_batches%rowtype; v_row public.import_batch_rows%rowtype;
  v_event public.events%rowtype; v_p public.participants%rowtype; v_count integer; v_created boolean:=false;
  v_cpf text:=nullif(regexp_replace(coalesce(p_cpf,''),'\D','','g'),''); v_issue jsonb;
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

  if v_row.resolution='link_existing' and v_row.matched_participant_id is not null then
    select * into v_p from public.participants where id=v_row.matched_participant_id and event_id=v_event.id for update;
  elsif p_expected_participant_id is not null then
    select * into v_p from public.participants where id=p_expected_participant_id and event_id=v_event.id for update;
  elsif public.is_valid_cpf(v_cpf) then
    select count(*) into v_count from public.participants where event_id=v_event.id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf;
    if v_count>1 then raise exception 'CPF possui mais de um participant no evento; revisao administrativa obrigatoria.'; end if;
    if v_count=1 then select * into v_p from public.participants where event_id=v_event.id and regexp_replace(coalesce(cpf,''),'\D','','g')=v_cpf for update; end if;
  end if;

  if v_p.id is null then
    insert into public.participants(event_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,
      registration_status,reservation_status,batch_id,ticket_category_id,notes)
    values(v_event.id,null,trim(p_full_name),v_cpf,p_birth_date,nullif(trim(p_gender),''),nullif(trim(p_phone),''),
      lower(nullif(trim(p_email),'')),nullif(trim(p_city),''),nullif(trim(p_shirt_type),''),nullif(trim(p_shirt_size),''),
      'pending','pending',p_registration_batch_id,p_ticket_category_id,'Importacao administrativa') returning * into v_p;
    v_created:=true;
  else
    if public.is_valid_cpf(v_p.cpf) and public.is_valid_cpf(v_cpf)
      and regexp_replace(v_p.cpf,'\D','','g')<>v_cpf then raise exception 'CPF legitimo existente diverge da linha importada.'; end if;
    update public.participants set full_name=trim(p_full_name),
      cpf=case when public.is_valid_cpf(cpf) then cpf else coalesce(v_cpf,cpf) end,
      birth_date=coalesce(p_birth_date,birth_date),gender=coalesce(nullif(trim(p_gender),''),gender),
      phone=coalesce(nullif(trim(p_phone),''),phone),email=coalesce(lower(nullif(trim(p_email),'')),email),
      city=coalesce(nullif(trim(p_city),''),city),shirt_type=coalesce(nullif(trim(p_shirt_type),''),shirt_type),
      shirt_size=coalesce(nullif(trim(p_shirt_size),''),shirt_size),batch_id=coalesce(p_registration_batch_id,batch_id),
      ticket_category_id=coalesce(p_ticket_category_id,ticket_category_id),updated_at=now()
    where id=v_p.id returning * into v_p;
  end if;

  update public.import_batch_rows set matched_participant_id=v_p.id,matched_user_id=null where id=v_row.id;
  perform public.reevaluate_participant_data_issues(v_p.id,v_batch.id);
  for v_issue in select value from jsonb_array_elements(coalesce(p_import_issues,'[]'::jsonb)) loop
    insert into public.participant_data_issues(organization_id,event_id,participant_id,import_batch_id,
      field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
    values(v_event.organization_id,v_event.id,v_p.id,v_batch.id,v_issue->>'field_code',v_issue->>'issue_type',
      v_issue->>'message',coalesce((v_issue->>'blocks_payment')::boolean,false),
      coalesce((v_issue->>'blocks_ticket_issuance')::boolean,false),coalesce((v_issue->>'blocks_checkin')::boolean,false),
      coalesce((v_issue->>'blocks_kit_delivery')::boolean,false)) on conflict do nothing;
  end loop;
  update public.payments set payment_method=coalesce(nullif(trim(p_payment_method),''),payment_method)
  where participant_id=v_p.id and payment_status<>'paid';
  return jsonb_build_object('participant_id',v_p.id,'created',v_created,'user_id',v_p.user_id,
    'has_issuance_blockers',public.import_participant_has_issuance_blockers(v_p.id));
end; $$;

revoke all on function public.is_valid_cpf(text) from public,anon,authenticated;
grant execute on function public.is_valid_cpf(text) to authenticated;
revoke all on function public.reevaluate_participant_data_issues(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reevaluate_participant_data_issues(uuid,uuid) to authenticated;
revoke all on function public.upsert_current_event_import_participant(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.upsert_current_event_import_participant(uuid,uuid,uuid,text,text,date,text,text,text,text,text,text,uuid,uuid,text,jsonb) to authenticated;

-- A finalizacao da 088 bloqueia somente pendencias financeiras ou de emissao.
revoke all on function public.import_participant_has_issuance_blockers(uuid) from public,anon,authenticated;
grant execute on function public.import_participant_has_issuance_blockers(uuid) to authenticated;

create or replace function public.finalize_imported_participant_after_issue_resolution(
  p_participant_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_participant public.participants%rowtype; v_batch public.import_batches%rowtype;
  v_payment public.payments%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_ticket_id uuid; v_batch_count integer; v_batch_id uuid; v_finalization text;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_participant.organization_id) then raise exception 'Usuario sem acesso ao participante.'; end if;

  select count(distinct ib.id),(array_agg(distinct ib.id order by ib.id))[1] into v_batch_count,v_batch_id
  from public.participation_history ph join public.import_batches ib on ib.id=ph.import_batch_id
    and ib.event_id=v_participant.event_id and ib.import_type='current_event_registrations'
  where ph.participant_id=p_participant_id and ph.source='import';
  if v_batch_count=0 then return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported'); end if;
  if v_batch_count<>1 then raise exception 'Mais de um lote de importacao comprovado para o participante.'; end if;
  select * into v_batch from public.import_batches where id=v_batch_id for update;

  if public.import_participant_has_issuance_blockers(p_participant_id) then
    v_finalization:='issues_remaining';
  else
    select * into v_payment from public.payments where participant_id=p_participant_id and event_id=v_participant.event_id
    order by created_at desc limit 1 for update;
    if not found or v_payment.amount is null or v_payment.final_amount is null then raise exception 'Pagamento real nao foi criado apos o recalculo.'; end if;
    if coalesce(v_batch.payment_mode_original,'pending')='pending' and not p_force_confirm then
      v_finalization:='payment_pending';
    else
      if not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then
        raise exception 'Sem permissao para confirmar o pagamento originalmente solicitado.';
      end if;
      update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
      select * into v_order from public.orders where participant_id=p_participant_id and event_id=v_participant.event_id
        and buyer_type='imported_holder' and user_id is null and import_batch_id=v_batch.id for update;
      if not found then
        if exists(select 1 from public.orders where participant_id=p_participant_id and event_id=v_participant.event_id) then
          raise exception 'Existe pedido de outra origem; regularizacao automatica bloqueada.';
        end if;
        insert into public.orders(user_id,participant_id,event_id,payment_id,order_number,status,base_amount,
          discount_amount,final_amount,buyer_type,import_batch_id,confirmed_at)
        values(null,p_participant_id,v_participant.event_id,v_payment.id,public.generate_order_number(),'confirmed',
          v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'imported_holder',v_batch.id,now()) returning * into v_order;
      else
        update public.orders set payment_id=v_payment.id,status='confirmed',confirmed_at=coalesce(confirmed_at,now()),
          base_amount=v_payment.amount,discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_order.id returning * into v_order;
      end if;
      update public.payments set order_id=v_order.id where id=v_payment.id;
      select * into v_item from public.order_items where order_id=v_order.id and participant_id=p_participant_id for update;
      if not found then
        insert into public.order_items(order_id,event_id,participant_id,ownership_status,holder_full_name,
          ticket_category_id,batch_id,shirt_type,shirt_size,quantity,unit_price,discount_amount,final_amount,status)
        values(v_order.id,v_participant.event_id,p_participant_id,'assigned',v_participant.full_name,
          v_participant.ticket_category_id,v_participant.batch_id,v_participant.shirt_type,v_participant.shirt_size,
          1,v_payment.amount,coalesce(v_payment.discount_amount,0),v_payment.final_amount,'confirmed') returning * into v_item;
      else
        update public.order_items set status='confirmed',unit_price=v_payment.amount,
          discount_amount=coalesce(v_payment.discount_amount,0),final_amount=v_payment.final_amount
        where id=v_item.id returning * into v_item;
      end if;
      select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
      if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
      update public.participants set registration_status='confirmed',updated_at=now() where id=p_participant_id;
      v_finalization:='paid_and_ticket_issued';
    end if;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_participant_issue_finalized','participants',p_participant_id,v_participant.event_id,
    jsonb_build_object('participant_id',p_participant_id,'import_batch_id',v_batch.id,
      'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'),'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),
      'payment_id',v_payment.id,'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id,
      'actor_user_id',v_actor,'source','participant_issue_resolution','finalization',v_finalization));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,
    'payment_id',v_payment.id,'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id,
    'payment_mode_original',coalesce(v_batch.payment_mode_original,'pending'));
end; $$;
revoke all on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean) from public,anon,authenticated;
grant execute on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean) to authenticated;

-- Corrige o caminho latente da 093 que criava uma projecao de titular usando
-- colunas financeiras historicas de participants. Preco e pagamento continuam
-- pertencendo ao order_item/order/payment originais.
create or replace function public.change_ticket_holder_by_pin_internal(
  p_ticket_id uuid,p_pin text,p_operation text,p_admin_override boolean default false,p_reason text default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype; v_event public.events%rowtype;
  v_target public.customer_profiles%rowtype; v_current public.participants%rowtype; v_target_participant public.participants%rowtype;
  v_pin text:=upper(regexp_replace(coalesce(p_pin,''),'[^A-Za-z0-9]','','g')); v_admin boolean; v_origin text; v_price record; v_priced_gender text; v_target_gender text;
  v_target_email text; v_target_participant_count integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id and status<>'cancelled' for update; if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update; select * into v_order from public.orders where id=v_ticket.order_id for update; select * into v_event from public.events where id=v_ticket.event_id;
  v_admin:=public.current_user_has_permission('participants.edit_basic') and public.user_can_access_organization(v_actor,v_ticket.organization_id);
  v_origin:=case when v_admin and p_admin_override then 'admin' else 'portal' end;
  if v_origin='portal' and v_actor<>v_order.user_id and not exists(select 1 from public.participants p where p.id=v_oi.participant_id and p.user_id=v_actor) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  if p_operation='holder_assigned' then
    if v_oi.participant_id is not null then raise exception 'Ingresso ja possui titular; use transferencia.'; end if;
    if not v_event.allow_holder_change and not(v_admin and p_admin_override) then raise exception 'Definicao de titular desabilitada para o evento.'; end if;
  elsif p_operation='ticket_transferred' then
    if v_oi.participant_id is null then raise exception 'Ingresso sem titular; use definicao de titular.'; end if;
    if not v_event.allow_ticket_transfer and not(v_admin and p_admin_override) then raise exception 'Transferencia desabilitada para o evento.'; end if;
  else raise exception 'Operacao invalida.'; end if;
  select * into v_target from public.customer_profiles where public_pin=v_pin and coalesce(account_status,'active')='active'; if not found then raise exception 'PIN nao encontrado.'; end if;
  if v_oi.participant_id is not null then select * into v_current from public.participants where id=v_oi.participant_id; end if;
  v_target_gender:=lower(trim(coalesce(v_target.gender,'')));
  select rbp.male_price,rbp.female_price into v_price from public.registration_batch_prices rbp where rbp.batch_id=v_oi.batch_id and rbp.ticket_category_id=v_oi.ticket_category_id;
  if v_price.male_price is distinct from v_price.female_price then
    v_priced_gender:=case when v_oi.unit_price=v_price.male_price and v_oi.unit_price is distinct from v_price.female_price then 'male' when v_oi.unit_price=v_price.female_price and v_oi.unit_price is distinct from v_price.male_price then 'female' end;
    if (v_priced_gender='male' and v_target_gender not in('male','masculino','m')) or (v_priced_gender='female' and v_target_gender not in('female','feminino','f')) or v_priced_gender is null then
      if not(v_admin and p_admin_override) then raise exception 'VALIDACAO_ADMINISTRATIVA: genero do usuario incompativel ou preco original ambiguo.'; end if;
    end if;
  end if;
  if v_current.id is not null and nullif(trim(v_oi.shirt_type),'') is not null and lower(trim(coalesce(v_current.gender,'')))<>v_target_gender and not(v_admin and p_admin_override) then
    raise exception 'VALIDACAO_ADMINISTRATIVA: camiseta existente exige revisao antes da transferencia.';
  end if;
  select count(*) into v_target_participant_count from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  if v_target_participant_count>1 then
    raise exception 'VALIDACAO_ADMINISTRATIVA: usuario possui multiplos cadastros de participante neste evento.';
  elsif v_target_participant_count=1 then
    select * into strict v_target_participant from public.participants where event_id=v_ticket.event_id and user_id=v_target.user_id;
  else
    select lower(trim(au.email)) into v_target_email from auth.users au where au.id=v_target.user_id;
    if nullif(v_target_email,'') is null then raise exception 'Conta de destino sem e-mail valido para criar participante.'; end if;
    insert into public.participants(event_id,organization_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_target.user_id,v_target.full_name,v_target.cpf,v_target.birth_date,v_target.gender,v_target.phone,v_target_email,v_target.city,
      nullif(trim(coalesce(v_oi.shirt_type,'')),''),nullif(trim(coalesce(v_oi.shirt_size,'')),''),'confirmed',v_oi.ticket_category_id,v_oi.batch_id) returning * into v_target_participant;
  end if;
  if v_current.user_id=v_target.user_id then raise exception 'Usuario ja e o titular do ingresso.'; end if;
  update public.order_items set participant_id=v_target_participant.id,holder_full_name=v_target.full_name,ownership_status=case when p_operation='ticket_transferred' then 'transferred' else 'assigned' end,updated_at=now() where id=v_oi.id;
  update public.tickets set participant_id=v_target_participant.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_ticket.id,v_oi.id,v_ticket.event_id,v_ticket.organization_id,p_operation,v_current.id,v_target_participant.id,v_current.user_id,v_target.user_id,v_actor,v_origin,nullif(trim(coalesce(p_reason,'')),''));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(p_operation,'tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('ticket_id',v_ticket.id,'previous_user_id',v_current.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'actor_origin',v_origin,'reason',nullif(trim(coalesce(p_reason,'')),'')));
  return v_target_participant.id;
end; $$;
revoke all on function public.change_ticket_holder_by_pin_internal(uuid,text,text,boolean,text) from public,anon,authenticated;

commit;
