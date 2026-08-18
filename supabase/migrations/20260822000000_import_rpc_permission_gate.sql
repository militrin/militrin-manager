-- Homologacao do modulo de Importacoes: import_current_event_contact_first
-- (a RPC que efetivamente cria cadastro/pedido/pagamento/ingresso a partir de
-- uma linha importada) nao verificava nenhuma permissao de negocio -- so
-- exigia autenticacao e acesso a organizacao do evento. A tela /importacoes
-- so bloqueia pelo layout (requirePermission('imports.view')), e
-- src/app/importacoes/actions.ts nunca chama assertPermission em nenhuma das
-- suas server actions. Reproduzido: um usuario autenticado, membro da
-- organizacao mas com uma permissao qualquer NAO relacionada (ex.:
-- checkin.scan) e sem imports.view, conseguiu chamar
-- import_current_event_contact_first diretamente (via RPC, contornando a
-- tela e a action por completo) e criar um cadastro + pedido + pagamento +
-- reserva reais. Corrigido adicionando a MESMA permissao (imports.view) ja
-- usada como porta de entrada da tela, diretamente na RPC que grava dados --
-- defesa em profundidade real, nao dependente de nenhuma verificacao do
-- lado do app.
--
-- NAO adicionado em resolve_import_registration_contact: essa funcao e
-- compartilhada com o checkout publico (create_registration a chama pra
-- resolver a identidade do proprio inscrito), e o usuario final do checkout
-- nunca tem (nem deveria ter) imports.view. Adicionar o check ali quebraria
-- o checkout publico.
-- NAO adicionado em finalize_imported_ticket_after_issue_resolution nem em
-- resolve_ticket_data_issues: sao dual-proposito por design (tambem usadas
-- pelo proprio titular resolvendo a propria pendencia em
-- /primeiro-acesso/pendencias, sem qualquer permissao administrativa) e ja
-- tem suas proprias checagens de acesso (owner da organizacao OU dono do
-- proprio ingresso).
begin;

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
  if v_actor is null or not public.current_user_has_permission('imports.view') then raise exception 'Sem permissao para importar cadastros.'; end if;
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

commit;
