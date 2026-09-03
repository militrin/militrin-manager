-- BUG REAL (auditoria do caso "TIEVENT", confirmado com dados de producao):
-- um titular importado conclui o primeiro acesso, corrige a pendencia
-- bloqueante (ex.: Genero), a pendencia fica 'resolved', mas o ingresso
-- IMPORTADO nunca e emitido -- a listagem mostra "0 ingressos" pra sempre,
-- sem nenhum aviso.
--
-- CAUSA RAIZ (nao e a mesma das duas auditorias anteriores sobre este
-- mesmo caso, 20260922000000/20260928000000 -- aquelas corrigiram a
-- pendencia nunca ficar 'resolved'; esta e o PROXIMO elo da mesma
-- corrente, depois que a pendencia ja resolve corretamente):
--
--   1) resolve_ticket_data_issues (chamada pela tela guiada de "primeiro
--      acesso"/pendencias) e finalize_imported_ticket_after_issue_resolution
--      (que de fato tenta emitir o ticket) sao DUAS RPCs SEPARADAS. O
--      unico chamador real de finalize_imported_ticket_after_issue_resolution
--      em todo o projeto e src/app/primeiro-acesso/actions.ts, UMA UNICA
--      VEZ, na mesma submissao em que a ultima pendencia e resolvida.
--
--   2) reevaluate_participant_data_issues (a funcao de reconciliacao
--      estrutural introduzida em 20260928000000, ja com 4 chamadores reais
--      via update_registration_contact_from_participant: checkout,
--      primeiro acesso, edicao administrativa, Minha Conta) resolve a
--      pendencia e ate recalcula preco -- mas NUNCA tenta emitir o
--      ticket. Confirmado no caso real: a pendencia de Genero do TIEVENT
--      foi resolvida via edicao de perfil posterior (audit_logs
--      'participant_data_issues_reevaluated' com source='edit'), NUNCA
--      pela tela guiada de primeiro acesso -- ou seja, o UNICO ponto que
--      tenta emitir ticket nem chegou a rodar pra este caso.
--
--   3) mesmo quando finalize_imported_ticket_after_issue_resolution E'
--      chamada (fluxo guiado), primeiro-acesso/actions.ts:257-261 so
--      confere finalization.error (erro de TRANSPORTE) -- nunca inspeciona
--      finalization.data.finalization (o resultado de NEGOCIO:
--      'issues_remaining'/'payment_pending'/'paid_and_ticket_issued', a
--      RPC sempre retorna success:true nos 3 casos). Um resultado
--      'payment_pending' (batch importado em payment_mode_original=
--      'pending', o modo DEFAULT do wizard de importacao -- ver
--      src/app/importacoes/ImportacoesClient.tsx) e tratado exatamente
--      como sucesso: "Primeiro acesso concluido com sucesso", sem
--      nenhuma pista de que o ingresso ficou pendente.
--
-- IMPORTANTE: 'payment_pending' e' um bloqueio de NEGOCIO REAL e
-- deliberado (o batch foi importado como "ainda precisa pagar", nao
-- "ja pago") -- esta correcao NUNCA contorna essa regra (nunca emite
-- ticket sem pagamento pra batches 'pending'). O que ela corrige e'
-- garantir que a TENTATIVA de emissao sempre aconteca (nunca fique so na
-- primeira leitura da issue) e que o motivo real, quando ha um, fique
-- registrado e visivel -- nunca um "0 ingressos" mudo.
--
-- CORRECAO (reusa a logica canonica existente, nunca duplica regra em
-- SQL/TypeScript nova):
--   a) nova funcao reconcile_imported_ticket_issuance_for_participant --
--      dado um participant_id, encontra TODOS os order_items de ingresso
--      IMPORTADOS deste participante que ainda nao tem ticket (nunca
--      assume "1 usuario = 1 order_item") e chama, pra cada um,
--      finalize_imported_ticket_after_issue_resolution (a MESMA RPC ja
--      existente e ja auditada -- nenhuma regra de negocio nova). Cada
--      item roda em savepoint proprio (BEGIN/EXCEPTION): um erro real
--      (ex.: HOLDER_ALREADY_HAS_TICKET_FOR_EVENT) num item nunca derruba
--      a reconciliacao dos demais nem propaga como excecao fatal pro
--      chamador (que normalmente so esta tentando salvar uma edicao de
--      perfil). O motivo de cada item fica no retorno estruturado.
--   b) reevaluate_participant_data_issues (chamada pelos 4 fluxos reais
--      que editam dado pessoal) passa a chamar essa reconciliacao no
--      final e devolver o resultado em 'ticket_reconciliation' -- os 4
--      chamadores ganham a garantia estrutural pedida sem precisar saber
--      disso, exatamente como o proprio 20260928000000 ja fez pra
--      reavaliacao de issues.
--   c) resolve_ticket_data_issues (chamada pela tela guiada de primeiro
--      acesso/pendencias) tambem chama a mesma reconciliacao no final
--      (cobre o caminho de correcao de categoria/lote/camiseta, que
--      resolve_import_ticket_options nunca passa por
--      reevaluate_participant_data_issues) e devolve em
--      'ticket_reconciliation' tambem -- assim o UNICO rpc call que a
--      tela de pendencias ja faz ja chega com a informacao completa.
--
-- Idempotente: rodar de novo sem nenhuma pendencia nova nao gera ticket
-- duplicado (finalize_imported_ticket_after_issue_resolution ja e'
-- idempotente por si so, e o SELECT de candidatos aqui so pega order_items
-- que AINDA nao tem ticket).
begin;

-- A decisao administrativa de um lote importado como confirm_all ja foi
-- tomada no momento da importacao. Se uma issue adiou a emissao, o titular
-- pode concluir a emissao depois de corrigir os dados sem precisar receber
-- a permissao finance.confirm_payment. p_force_confirm continua reservado a
-- quem possui essa permissao e lotes pending continuam retornando
-- payment_pending.
create or replace function public.finalize_imported_ticket_after_issue_resolution(
  p_order_item_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_payment public.payments%rowtype; v_batch public.import_batches%rowtype; v_ticket_id uuid; v_blocked boolean; v_finalization text;
  v_can_confirm boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported');
  end if;
  if not public.user_can_access_organization(v_actor,v_order.organization_id) and not exists(
    select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into v_batch from public.import_batches where id=v_order.import_batch_id for update;
  select exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open' and i.blocks_ticket_issuance) into v_blocked;
  if v_blocked then
    v_finalization:='issues_remaining';
  elsif coalesce(v_batch.payment_mode_original,'pending')='pending' and not p_force_confirm then
    v_finalization:='payment_pending';
  else
    v_can_confirm := coalesce(v_batch.payment_mode_original,'pending')='confirm_all'
      or public.is_active_owner(v_actor)
      or public.resolve_user_permission(v_actor,'finance.confirm_payment');
    if not v_can_confirm then raise exception 'Sem permissao para confirmar o pagamento.'; end if;
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

create or replace function public.reconcile_imported_ticket_issuance_for_participant(p_participant_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_row record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_attempted integer := 0;
begin
  if p_participant_id is null then
    return jsonb_build_object('attempted', 0, 'results', '[]'::jsonb);
  end if;

  -- Todo order_item de INGRESSO, de pedido IMPORTADO, deste participante,
  -- que ainda nao tem ticket -- nunca so o "primeiro"/"principal": um
  -- mesmo pedido importado pode ter mais de um ingresso do mesmo titular.
  -- Produto de loja/"compre junto" (item_kind='product') nunca entra aqui
  -- -- mesmo filtro canonico ja usado por PAID_ORDER_WITHOUT_TICKET
  -- (item_kind='ticket' e a fonte de verdade em todo o projeto).
  for v_row in
    select oi.id as order_item_id
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.participant_id = p_participant_id
      and oi.item_kind = 'ticket'
      and o.buyer_type = 'imported_holder'
      and o.import_batch_id is not null
      and oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
      and not exists (select 1 from public.tickets t where t.order_item_id = oi.id)
    order by oi.created_at
  loop
    v_attempted := v_attempted + 1;
    begin
      v_result := public.finalize_imported_ticket_after_issue_resolution(v_row.order_item_id);
    exception when others then
      -- Nunca deixa um erro real (ex.: titularidade duplicada,
      -- HOLDER_ALREADY_HAS_TICKET_FOR_EVENT) de UM item derrubar a
      -- reconciliacao dos demais nem propagar como excecao fatal pro
      -- chamador -- que normalmente so esta tentando salvar uma edicao de
      -- perfil, nunca deveria falhar por causa de OUTRO ingresso. O
      -- motivo real fica registrado no retorno, nunca silenciado.
      v_result := jsonb_build_object('success', false, 'applicable', true, 'finalization', 'error',
        'error_code', sqlstate, 'error_message', sqlerrm);
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      select 'imported_ticket_reconciliation_failed','order_items',oi.id,oi.event_id,
        jsonb_build_object('actor_user_id',auth.uid(),'participant_id',p_participant_id,
          'error_code',sqlstate,'error_message',sqlerrm)
      from public.order_items oi where oi.id=v_row.order_item_id;
    end;
    v_results := v_results || jsonb_build_array(v_result || jsonb_build_object('order_item_id', v_row.order_item_id));
  end loop;

  return jsonb_build_object('attempted', v_attempted, 'results', v_results);
end;
$$;

revoke all on function public.reconcile_imported_ticket_issuance_for_participant(uuid) from public, anon;
grant execute on function public.reconcile_imported_ticket_issuance_for_participant(uuid) to authenticated, service_role;

-- Etapa final do onboarding: procura todos os participants/contacts ligados
-- a conta, sem depender do convite ou de uma issue especifica ter disparado.
create or replace function public.reconcile_imported_ticket_issuance_for_user(p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid:=auth.uid();
  v_participant record;
  v_summary jsonb;
  v_results jsonb := '[]'::jsonb;
  v_attempted integer := 0;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_user_id is null then p_user_id:=v_actor; end if;
  if p_user_id is distinct from v_actor and not public.is_active_owner(v_actor) then
    raise exception 'Usuario sem acesso a reconciliacao.';
  end if;

  for v_participant in
    select distinct p.id
    from public.participants p
    left join public.registration_contacts rc on rc.id=p.registration_contact_id
    where p.user_id=p_user_id or rc.user_id=p_user_id
    order by p.id
  loop
    v_summary:=public.reconcile_imported_ticket_issuance_for_participant(v_participant.id);
    v_attempted:=v_attempted+coalesce((v_summary->>'attempted')::integer,0);
    v_results:=v_results||coalesce(v_summary->'results','[]'::jsonb);
  end loop;
  return jsonb_build_object('attempted',v_attempted,'results',v_results);
end; $$;

revoke all on function public.reconcile_imported_ticket_issuance_for_user(uuid) from public, anon;
grant execute on function public.reconcile_imported_ticket_issuance_for_user(uuid) to authenticated, service_role;

-- ============================================================
-- reevaluate_participant_data_issues -- redefinida a partir da versao
-- vigente (20260928000000). Corpo original preservado integralmente, so
-- a chamada de reconciliacao nova antes do retorno.
-- ============================================================
create or replace function public.reevaluate_participant_data_issues("p_participant_id" "uuid", "p_import_batch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_e public.events%rowtype;
  v_price public.registration_batch_prices%rowtype; v_gender text; v_base numeric;
  v_age integer; v_open integer; v_issue record;
  v_batch_id uuid; v_category_id uuid; v_has_modern_order_item boolean;
  v_ticket_item public.order_items%rowtype; v_modern_order public.orders%rowtype; v_modern_payment public.payments%rowtype;
  v_ticket_reconciliation jsonb;
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

  if v_batch_id is null or not exists(select 1 from public.registration_batches rb where rb.id=v_batch_id and rb.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('batch','unresolved','Lote nao resolvido de forma deterministica.',true,true,false,false);
  end if;
  if v_category_id is null or not exists(select 1 from public.ticket_categories tc where tc.id=v_category_id and tc.event_id=v_p.event_id) then
    insert into pg_temp.expected_import_issues values('category','unresolved','Categoria nao resolvida de forma deterministica.',true,true,false,false);
  end if;

  if v_batch_id is not null and v_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id=v_batch_id and ticket_category_id=v_category_id;
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
          if found then
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
      else
        update public.payments set amount=round(v_base,2),discount_amount=0,final_amount=round(v_base,2),updated_at=now()
        where participant_id=v_p.id and payment_status<>'paid';
        if not exists(select 1 from public.payments where participant_id=v_p.id and event_id=v_p.event_id) then
          insert into public.payments(participant_id,event_id,amount,discount_amount,final_amount,payment_method,payment_status)
          values(v_p.id,v_p.event_id,round(v_base,2),0,round(v_base,2),'pix','pending');
        end if;
      end if;
    end if;
  end if;

  -- NOVO: depois de reconciliar issues/preco, tenta finalizar/emitir
  -- qualquer ingresso importado deste participante que ainda nao tem
  -- ticket. Reusa a mesma RPC canonica (finalize_imported_ticket_after_
  -- issue_resolution) -- nunca duplica a regra de negocio aqui. So roda
  -- quando ha order_item de ingresso vinculado (mesmo guard de
  -- v_has_modern_order_item acima) -- fluxo legado sem order_items nunca
  -- teve emissao automatizada por aqui.
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

-- ============================================================
-- resolve_ticket_data_issues -- redefinida a partir da versao vigente
-- (20260922000000). Corpo original preservado integralmente, so a
-- chamada de reconciliacao nova antes do retorno.
-- ============================================================
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
    and coalesce(v_payment.payment_status,'pending')<>'paid' then
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

  -- NOVO: depois de aplicar todas as correcoes desta submissao (pessoal,
  -- categoria/lote, camiseta) e fechar as issues que deixaram de se
  -- aplicar, tenta finalizar/emitir TODOS os ingressos importados deste
  -- participante que ainda nao tem ticket -- nunca so o order_item que
  -- motivou esta chamada (um mesmo pedido pode ter mais de um ingresso do
  -- mesmo titular). Reusa a mesma RPC canonica, nunca duplica regra.
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

commit;
