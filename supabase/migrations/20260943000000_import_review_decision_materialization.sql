-- INVESTIGACAO (teste real, cadastro TIEVENT): um cadastro antigo teve
-- nome/e-mail alterados para reaproveitar dados de teste; uma nova
-- importacao com uma pessoa chamada "TIEVENT" caiu em revisao (sugestao por
-- nome, candidato = o cadastro antigo, calculado com os dados ATUAIS dele --
-- confirmado que a deteccao em src/app/importacoes/actions.ts sempre lê
-- registration_contacts/participants ao vivo no momento do upload, nunca um
-- snapshot obsoleto). O administrador escolheu "Outra pessoa / criar novo
-- cadastro" na fila /importacoes/revisoes. A UI se comportou como se a
-- decisao tivesse concluido (a linha some da fila), mas nenhum cadastro novo
-- foi criado -- confirmado lendo resolve_import_batch_row_review
-- (20260941000000): a funcao SEMPRE existiu apenas como um registro de
-- METADADO da decisao (resolution/registration_contact_id/review_decision) e
-- nunca chama import_current_event_contact_first (a RPC que de fato cria
-- registration_contact/participant/order/order_item). A UNICA rotina que
-- chama import_current_event_contact_first e' o loop de
-- executeImportBatchAction em src/app/importacoes/actions.ts, disparado so
-- pelo botao "Executar importacao" da tela /importacoes -- nunca
-- automaticamente apos uma decisao de revisao. A linha ficava presa para
-- sempre com status='review_required' e resolution='create_new' (ou
-- 'link_existing'), sem cadastro/participant/order/order_item algum: por
-- isso o novo TIEVENT nunca apareceu em Administracao -> Cadastros (a tela
-- consulta registration_contacts -- a entidade nunca chegou a ser criada,
-- nao e' um problema de consulta).
--
-- Causa raiz secundaria, achada auditando import_current_event_contact_first
-- (20260822000000) para reusa-la aqui: ela NUNCA foi idempotente por linha
-- -- sempre insere um novo payments/orders/order_items a cada chamada, sem
-- checar se aquela import_batch_row ja tinha sido materializada antes. Isso
-- já era um risco real e independente antes desta correcao (reexecutar
-- executeImportBatchAction para o mesmo lote -- ex.: pelo link "Abrir e
-- reprocessar batch" -- reprocessa TAMBEM linhas com status='imported',
-- porque isRowReadyToImport(status,resolution) devolve true por padrao para
-- qualquer status que nao seja 'error'/'duplicate'/'review_required',
-- duplicando pedido/pagamento/participante da mesma pessoa). Corrigido na
-- propria RPC canonica, beneficiando os dois chamadores (batch e revisao).
--
-- Correcao: resolve_import_batch_row_review passa a materializar a decisao
-- imediatamente, na MESMA transacao (chamando a mesma RPC canonica que o
-- executor de lote usa, nunca duplicando as regras de negocio em
-- TypeScript), lendo os dados ja normalizados persistidos na propria linha
-- (normalized_data/data_issues -- os mesmos que executeImportBatchAction
-- envia hoje). Se a materializacao falhar por qualquer motivo, a excecao
-- propaga e a transacao inteira desfaz (inclusive qualquer escrita parcial
-- dentro de import_current_event_contact_first): a linha permanece
-- exatamente como estava (status='review_required', resolution='pending'),
-- reaparece na fila de revisao, e o erro real chega ao administrador via
-- resolveImportReviewAction/submitReview (ver alteracoes em
-- src/app/importacoes/revisoes/page.tsx). So depois que a materializacao
-- tiver sucesso a linha e marcada como resolvida (status='imported').
-- Idempotente: reenviar a mesma decisao para uma linha ja materializada nao
-- gera segundo cadastro/participant/order/order_item (guarda nova em
-- import_current_event_contact_first) nem repete o INSERT de auditoria (a
-- guarda "if v_row.status<>'review_required' or v_row.resolution<>'pending'"
-- ja existente devolve sucesso sem mudar nada).
--
-- Escopo desta correcao: somente lotes import_type='current_event_registrations'
-- (o unico que emite ingresso e para o qual TODOS os 20 cenarios pedidos se
-- aplicam). Lotes historical_participations continuam com o comportamento de
-- metadado que ja tinham antes desta migration -- risco residual documentado
-- no relatorio final, fora do escopo deste teste real (participacao
-- historica nao gera pedido/ingresso).
begin;

-- 1) Idempotencia na RPC canonica de materializacao -- corrige o risco
-- independente descrito acima e da' a garantia que resolve_import_batch_row_review
-- (abaixo) precisa para poder chamar esta funcao com seguranca em qualquer
-- retentativa.
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

  -- Idempotencia: linha ja materializada antes (order_item_id gravado) nunca
  -- gera um segundo pedido/pagamento/participante -- devolve o resultado ja
  -- existente em vez de inserir de novo.
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

-- 2) resolve_import_batch_row_review passa a materializar create_new/
-- link_existing de imediato (mesma transacao) para lotes de inscritos do
-- evento atual, reusando a RPC canonica acima -- nunca reimplementando a
-- logica de identidade/pedido/ingresso em TypeScript. Assinatura inalterada.
create or replace function public.resolve_import_batch_row_review(
  p_row_id uuid,p_decision text,p_registration_contact_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_row public.import_batch_rows%rowtype; v_batch public.import_batches%rowtype;
  v_contact public.registration_contacts%rowtype; v_candidate_allowed boolean:=false;
  v_normalized jsonb; v_materialize jsonb; v_finalize jsonb; v_ticket_id uuid;
  v_has_pending_review boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_decision not in('link_existing','create_new','ignore') then raise exception 'Decisao de revisao invalida.'; end if;
  select * into v_row from public.import_batch_rows where id=p_row_id for update;
  if not found then raise exception 'Linha de importacao nao encontrada.'; end if;
  select * into v_batch from public.import_batches where id=v_row.import_batch_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_batch.organization_id)
    or not public.resolve_user_permission(v_actor,'imports.view') then raise exception 'Sem permissao para revisar esta importacao.'; end if;
  if v_row.status<>'review_required' or v_row.resolution<>'pending' then
    return jsonb_build_object('success',true,'changed',false,'status',v_row.status,'resolution',v_row.resolution);
  end if;

  if p_decision='link_existing' then
    if p_registration_contact_id is null then raise exception 'Selecione o cadastro candidato.'; end if;
    select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_batch.organization_id;
    if not found then raise exception 'Cadastro candidato invalido para esta organizacao.'; end if;
    select exists(
      select 1 from jsonb_array_elements(coalesce(v_row.identity_match_details->'candidates','[]'::jsonb)) c
      where c->>'registration_contact_id'=p_registration_contact_id::text
    ) or v_row.registration_contact_id=p_registration_contact_id into v_candidate_allowed;
    if not v_candidate_allowed then raise exception 'Cadastro nao consta entre os candidatos auditados desta linha.'; end if;
  end if;

  if p_decision='ignore' then
    update public.import_batch_rows set status='skipped',resolution='ignore',review_decision=p_decision,
      reviewed_by=v_actor,reviewed_at=now(),updated_at=now() where id=v_row.id;
  elsif v_batch.import_type='current_event_registrations' then
    -- import_current_event_contact_first (chamada abaixo) exige
    -- imported_by=ator, sem excecao alguma (nem platform owner) -- checagem
    -- replicada aqui so para dar uma mensagem clara ANTES de tentar
    -- materializar, nunca divergindo da regra real da RPC canonica.
    if v_batch.imported_by<>v_actor then
      raise exception 'Apenas o operador original do lote pode concluir esta revisao.';
    end if;
    v_normalized:=coalesce(v_row.normalized_data,'{}'::jsonb);

    -- Chama a MESMA RPC canonica que o executor de lote usa -- se falhar,
    -- a excecao propaga e desfaz TUDO nesta transacao (inclusive qualquer
    -- escrita parcial abaixo feita pela propria RPC): a linha nunca fica
    -- marcada como resolvida sem a pessoa/pedido terem sido de fato criados.
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
      p_assign_holder:=true
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
  else
    -- Lotes que nao sao de inscritos do evento atual (ex.: participacao
    -- historica) continuam apenas com o registro de metadado -- fora do
    -- escopo desta correcao (nao emitem pedido/ingresso).
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
    'registration_contact_id',coalesce(v_materialize->>'registration_contact_id',case when p_decision='link_existing' then p_registration_contact_id::text end),
    'order_item_id',v_materialize->>'order_item_id','ticket_id',v_ticket_id,
    'identity_match_details',v_row.identity_match_details));

  -- Recalcula os contadores/estado do lote -- so vira 'completed' quando nao
  -- restar nenhuma revisao realmente pendente (mesma regra que
  -- executeImportBatchAction ja aplica ao final do processamento em lote).
  select exists(
    select 1 from public.import_batch_rows r where r.import_batch_id=v_batch.id and r.status='review_required' and r.resolution='pending'
  ) into v_has_pending_review;
  update public.import_batches b set
    imported_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='imported'),
    error_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status='error'),
    skipped_rows=(select count(*) from public.import_batch_rows r where r.import_batch_id=b.id and r.status in('duplicate','skipped')),
    status=case when v_has_pending_review then 'ready_for_review' else 'completed' end,
    completed_at=case when v_has_pending_review then null else coalesce(b.completed_at,now()) end
  where b.id=v_batch.id;

  return jsonb_build_object('success',true,'changed',true,
    'status',case when p_decision='ignore' then 'skipped' when v_batch.import_type='current_event_registrations' then 'imported' else 'review_required' end,
    'resolution',p_decision,'registration_contact_id',v_materialize->>'registration_contact_id',
    'participant_id',v_materialize->>'participant_id','order_id',v_materialize->>'order_id',
    'payment_id',v_materialize->>'payment_id','order_item_id',v_materialize->>'order_item_id','ticket_id',v_ticket_id);
end; $$;

revoke all on function public.resolve_import_batch_row_review(uuid,text,uuid) from public,anon;
grant execute on function public.resolve_import_batch_row_review(uuid,text,uuid) to authenticated,service_role;

commit;
