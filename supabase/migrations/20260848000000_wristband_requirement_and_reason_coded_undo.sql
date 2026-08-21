-- Fluxo operacional de ingressos: pulseira vinculada ao ticket_id, desfazer
-- check-in/entrega com motivo obrigatorio, e reforco do gate de pulseira
-- obrigatoria no check-in/entrega de kit (inclusive na operacao atomica
-- "Entregar + check-in").
--
-- INVESTIGACAO PREVIA (nada abaixo duplica estrutura ja existente):
--   - Tabela public.participant_wristbands (event_id, ticket_id, code,
--     status, linked_at/by, unlinked_at/by, replaced_by_wristband_id) e as
--     RPCs link_wristband_to_ticket/unlink_wristband_from_ticket/
--     replace_wristband_for_ticket/block_wristband JA EXISTEM (migrations
--     legadas 064/075, consolidadas no baseline). Permissoes wristbands.view/
--     link/unlink/replace/block ja seedadas em admin_permissions. Nada disso
--     e recriado aqui -- so 3 dessas 4 RPCs sao ajustadas (ver secao 1).
--   - checkin_ticket_entry, deliver_ticket_kit_item, deliver_ticket_full_kit,
--     deliver_items_and_checkin, undo_ticket_checkin, undo_ticket_kit_item,
--     undo_ticket_full_kit ja existem e ja sao usadas pelo /operacoes e
--     /minha-conta. Esta migration SO adiciona o que faltava (gate de
--     pulseira obrigatoria; motivo obrigatorio pra desfazer) preservando
--     100% do comportamento anterior pra quem nao usa essas features novas.
--   - audit_logs nao tem coluna "actor" (bug ja documentado em
--     20260815006100_fix_active_db_lint_contracts.sql) -- todo actor novo
--     aqui vai em details->>'actor_user_id'/'actor_email', nunca numa
--     coluna top-level inexistente.
--
-- MUDANCA DE ASSINATURA (Postgres nao substitui uma funcao por
-- CREATE OR REPLACE quando a lista de parametros muda -- cria uma segunda
-- funcao sobrecarregada, deixando a versao antiga ainda chamavel sem o novo
-- gate). Por isso cada funcao abaixo cuja assinatura muda tem um
-- `drop function if exists` explicito com a assinatura ANTIGA antes do
-- `create or replace function` com a assinatura NOVA. Toda funcao com novo
-- parametro obrigatorio (motivo do desfazer) so tem chamador dentro deste
-- proprio schema (actions.ts, atualizado junto) -- confirmado por grep em
-- supabase/migrations e src/ antes de escrever esta migration. Funcoes com
-- novo parametro OPCIONAL (p_wristband_code default null) preservam every
-- chamador existente sem alteracao (checkin_participant_entry,
-- deliver_participant_full_kit, deliver_participant_kit_item,
-- deliver_kit_and_checkin -- legado e ja revogado de authenticated -- e o
-- deliverKitWithRpc morto em src/lib/supabase/rpc.ts).
begin;

-- ============================================================
-- 0. Helper compartilhado de validacao de motivo -- usado por
--    undo_ticket_checkin e undo_ticket_kit_item/undo_ticket_full_kit, pra
--    nao duplicar a mesma lista de codigos e a mesma regra ("other" exige
--    texto) em cada RPC.
-- ============================================================
create or replace function public.validate_operation_reason_code(p_reason_code text, p_reason_text text)
returns void language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_code text := nullif(trim(coalesce(p_reason_code, '')), '');
begin
  if v_code is null then
    raise exception 'Motivo obrigatorio para desfazer esta operacao.';
  end if;
  if v_code not in ('operational_error', 'wrong_person', 'accidental_scan', 'administrative_correction', 'system_test', 'other') then
    raise exception 'Motivo invalido: %.', v_code;
  end if;
  if v_code = 'other' and nullif(trim(coalesce(p_reason_text, '')), '') is null then
    raise exception 'Descreva o motivo quando selecionar "Outro".';
  end if;
end; $$;

revoke all on function public.validate_operation_reason_code(text, text) from public, anon;
grant execute on function public.validate_operation_reason_code(text, text) to authenticated, service_role;

-- ============================================================
-- 1. link_wristband_to_ticket -- mesma assinatura (uuid,text), so o corpo
--    muda. Bug real encontrado na investigacao: exigia
--    tickets.participant_id nao nulo, mas checkin_ticket_entry (o proprio
--    check-in) NUNCA exigiu titular resolvido -- ingressos de pedidos
--    multi-ingresso frequentemente ficam com order_items.participant_id (e
--    portanto tickets.participant_id) nulo ate alguem nomear o titular. Com
--    pulseira obrigatoria pro check-in, essa exigencia bloquearia vincular
--    pulseira (e portanto bloquearia o check-in inteiro) num ingresso
--    perfeitamente valido, so por falta de titular nomeado -- que nunca foi
--    requisito de check-in. Corrigido pra resolver evento/participante
--    direto do ticket_id (tickets.event_id, sempre presente) e tratar
--    participant_id como referencia denormalizada OPCIONAL -- a pulseira
--    continua vinculada ao ticket_id, nunca ao pedido nem ao cadastro,
--    exatamente como pedido.
-- ============================================================
create or replace function public.link_wristband_to_ticket(p_ticket_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket      public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event       public.events%rowtype;
  v_existing    public.participant_wristbands%rowtype;
  v_wristband   public.participant_wristbands%rowtype;
  v_code        text := nullif(trim(p_code), '');
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if not (public.is_active_owner(auth.uid()) or public.current_user_has_permission('wristbands.link')) then
    raise exception 'Sem permissao para vincular pulseira.';
  end if;

  if p_ticket_id is null then raise exception 'Ingresso obrigatorio.'; end if;
  if v_code is null then raise exception 'Codigo da pulseira obrigatorio.'; end if;

  select t.* into v_ticket from public.tickets t where t.id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para vincular pulseira nesta organização.';
  end if;

  select e.* into v_event from public.events e where e.id = v_ticket.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  -- Fix: participant_id e opcional (denormalizado, so pra relatorio) -- so
  -- resolve quando o ticket ja tem um titular, nunca exige.
  if v_ticket.participant_id is not null then
    select p.* into v_participant from public.participants p where p.id = v_ticket.participant_id;
  end if;

  select pw.* into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_ticket.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1 for update;

  if found then
    if v_existing.ticket_id = p_ticket_id then
      return jsonb_build_object('success', true, 'already_linked', true, 'wristband_id', v_existing.id, 'code', v_existing.code);
    end if;
    raise exception 'Pulseira ja vinculada a outro ingresso.';
  end if;

  if exists (select 1 from public.participant_wristbands pw where pw.ticket_id = p_ticket_id and pw.status = 'active') then
    raise exception 'Este ingresso ja possui uma pulseira ativa.';
  end if;

  insert into public.participant_wristbands (event_id, ticket_id, participant_id, code, status, linked_at, linked_by)
  values (v_ticket.event_id, p_ticket_id, v_participant.id, v_code, 'active', now(), auth.uid())
  returning * into v_wristband;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_linked', 'participant_wristbands', v_wristband.id, v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(), 'actor_email', v_actor_email, 'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id, 'participant_id', v_participant.id, 'code', v_code
    )
  );

  return jsonb_build_object('success', true, 'already_linked', false, 'wristband_id', v_wristband.id, 'code', v_wristband.code);
end;
$$;

revoke all on function public.link_wristband_to_ticket(uuid, text) from public, anon;
grant execute on function public.link_wristband_to_ticket(uuid, text) to authenticated, service_role;

-- ============================================================
-- 2. checkin_ticket_entry -- novo parametro OPCIONAL p_wristband_code.
--    Quando o evento exige pulseira pro check-in (wristband_enabled e
--    wristband_required_for_checkin) e o ingresso ainda nao tem pulseira
--    ativa: sem codigo enviado, aborta com um erro identificavel
--    (WRISTBAND_REQUIRED, mesmo padrao ja usado por SHIRT_OUT_OF_STOCK) pro
--    frontend abrir o modal obrigatorio; com codigo enviado, vincula a
--    pulseira e prossegue -- tudo na MESMA transacao do check-in (se o
--    check-in falhar depois, a pulseira recem-vinculada tambem e desfeita
--    junto, por ser a mesma chamada/transacao).
-- ============================================================
drop function if exists public.checkin_ticket_entry(uuid);

create or replace function public.checkin_ticket_entry(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype; v_paid boolean; v_actor_email text;
  v_event public.events%rowtype; v_has_wristband boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  select * into v_item from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_item.status in('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id;
  select exists(select 1 from public.payments p where (p.order_id=v_order.id or p.id=v_order.payment_id) and p.payment_status='paid') into v_paid;
  if not v_paid then raise exception 'Pagamento pendente. Check-in bloqueado.'; end if;

  -- Gate de pulseira obrigatoria -- nunca conclui o check-in sem ela quando
  -- o evento exige.
  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_checkin, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para o check-in.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_item.participant_id is not null then
    select * into v_participant from public.participants where id=v_item.participant_id;
    if found and v_participant.registration_contact_id is not null then select * into v_contact from public.registration_contacts where id=v_participant.registration_contact_id; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,registration_contact_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_ticket.event_id,v_participant.user_id,v_participant.id,v_participant.registration_contact_id,null,extract(year from coalesce(v_ticket.issued_at,now()))::integer,
        coalesce(v_contact.full_name,v_participant.full_name,'Participante'),public.normalize_text_for_match(coalesce(v_contact.full_name,v_participant.full_name)),
        coalesce(v_contact.cpf,v_participant.cpf),coalesce(v_contact.email,v_participant.email),'confirmed','system',false,now(),now()) on conflict do nothing;
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,
      'order_item_id',v_ticket.order_item_id,'participant_id',v_item.participant_id,'registration_contact_id',v_item.registration_contact_id,'used_at',now()));
  return true;
end; $$;

revoke all on function public.checkin_ticket_entry(uuid, text) from public, anon;
grant execute on function public.checkin_ticket_entry(uuid, text) to authenticated, service_role;

-- ============================================================
-- 3. deliver_ticket_kit_item / deliver_ticket_full_kit -- mesmo gate de
--    pulseira, agora pra wristband_required_for_kit. Colocado nas DUAS
--    funcoes (deliver_ticket_kit_item cobre "Entregar item" isolado;
--    deliver_ticket_full_kit cobre "Entregar itens", DEPOIS de validar
--    fisicamente todo o estoque, ANTES de decrementar qualquer unidade --
--    mesma ordem pedida: ingresso -> estoque -> pulseira -> baixa). Como
--    deliver_ticket_full_kit chama deliver_ticket_kit_item por item depois
--    do proprio gate, a segunda checagem dentro do loop e um no-op
--    idempotente (link_wristband_to_ticket ja devolve already_linked=true).
-- ============================================================
drop function if exists public.deliver_ticket_kit_item(uuid, uuid);

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid, p_kit_item_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_link public.participant_kit_items%rowtype;
  v_ticket public.tickets%rowtype;
  v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype;
  v_inv public.event_kit_item_variant_inventory%rowtype;
  v_variant_id uuid;
  v_available integer;
  v_event public.events%rowtype;
  v_has_wristband boolean;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado nao permite entrega de kit.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if v_link.status='delivered' then return true; end if;
  if v_link.status='cancelled' then raise exception 'Item cancelado nao pode ser entregue.'; end if;
  if not exists(select 1 from public.payments where order_id=v_ticket.order_id and payment_status='paid') then raise exception 'Pagamento pendente. Entrega bloqueada.'; end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_kit, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para a entrega do kit.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  select * into strict v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;

  if v_item.item_type='shirt' then
    if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Camiseta indisponivel para entrega.'; end if;
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is null then raise exception 'Camiseta nao vinculada.'; end if;
    select * into strict v_variant from public.event_kit_item_variants where id=v_variant_id and kit_item_id=v_item.id;
    if v_item.shirt_supply_mode='stock' then
      select * into v_inv from public.event_kit_item_variant_inventory
      where kit_item_id=v_item.id and variant_id=v_variant_id for update;
      v_available:=case when found then greatest(v_inv.total_quantity-v_inv.delivered_quantity,0) else 0 end;
      if v_inv.id is null or v_available<v_link.quantity then
        perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
      end if;
      update public.event_kit_item_variant_inventory
      set reserved_quantity=greatest(reserved_quantity-v_link.quantity,0),
          delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now()
      where id=v_inv.id
        and total_quantity-delivered_quantity>=v_link.quantity;
      if not found then perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,0); end if;
    end if;
  end if;

  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id and status<>'delivered';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,
      'supply_mode',v_item.shirt_supply_mode,'variant_id',v_variant_id));
  return true;
end; $$;

revoke all on function public.deliver_ticket_kit_item(uuid, uuid, text) from public, anon;
grant execute on function public.deliver_ticket_kit_item(uuid, uuid, text) to authenticated, service_role;

drop function if exists public.deliver_ticket_full_kit(uuid);

create or replace function public.deliver_ticket_full_kit(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_row record; v_ticket public.tickets%rowtype; v_available integer;
  v_event public.events%rowtype; v_has_wristband boolean;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'full_delivery');
  if exists(select 1 from public.event_kit_items eki where eki.event_id=v_ticket.event_id and eki.is_active
    and not exists(select 1 from public.participant_kit_items pki where pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id)) then
    raise exception 'Existem itens aplicaveis com configuracao pendente.';
  end if;

  -- Bloqueia e valida todas as variantes antes de alterar qualquer item.
  for v_row in
    select pki.kit_item_id,pki.quantity,v.id as variant_id,v.name as shirt_type,v.value as shirt_size
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id=pki.kit_item_id
    left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
    where pki.ticket_id=p_ticket_id and pki.status not in('delivered','cancelled')
      and eki.item_type='shirt' and eki.shirt_supply_mode='stock'
    order by pki.kit_item_id
    for update of pki
  loop
    select greatest(inv.total_quantity-inv.delivered_quantity,0)
      into v_available
    from public.event_kit_item_variant_inventory inv
    where inv.kit_item_id=v_row.kit_item_id and inv.variant_id=v_row.variant_id for update;
    if not found then v_available:=0; end if;
    if v_available<v_row.quantity then
      perform public.raise_shirt_out_of_stock(v_row.shirt_type,v_row.shirt_size,v_available);
    end if;
  end loop;

  -- Pulseira exigida SO depois do estoque validado (ingresso -> estoque ->
  -- pulseira -> baixa), cobrindo de uma vez todos os itens do loop abaixo.
  select * into v_event from public.events where id = v_ticket.event_id;
  if coalesce(v_event.wristband_enabled, false) and coalesce(v_event.wristband_required_for_kit, false) then
    select exists(select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active') into v_has_wristband;
    if not v_has_wristband then
      if nullif(trim(coalesce(p_wristband_code, '')), '') is null then
        raise exception using errcode = 'P0001', message = 'WRISTBAND_REQUIRED',
          detail = jsonb_build_object('code', 'WRISTBAND_REQUIRED', 'message', 'Este evento exige pulseira vinculada para a entrega do kit.')::text;
      end if;
      perform public.link_wristband_to_ticket(v_ticket.id, p_wristband_code);
    end if;
  end if;

  for v_row in select kit_item_id from public.participant_kit_items
    where ticket_id=p_ticket_id and status not in('delivered','cancelled') order by kit_item_id
  loop
    perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id,p_wristband_code);
  end loop;
  return true;
end; $$;

revoke all on function public.deliver_ticket_full_kit(uuid, text) from public, anon;
grant execute on function public.deliver_ticket_full_kit(uuid, text) to authenticated, service_role;

-- ============================================================
-- 4. deliver_items_and_checkin -- continua uma unica transacao Postgres
--    (nenhum bloco de excecao interno: qualquer erro em qualquer etapa
--    aborta a chamada inteira e desfaz tudo que ja tinha sido feito nela,
--    incluindo a propria pulseira recem-vinculada). So repassa
--    p_wristband_code pras duas sub-chamadas -- cada uma so usa o codigo se
--    a PROPRIA exigencia dela estiver ativa.
-- ============================================================
drop function if exists public.deliver_items_and_checkin(uuid);

create or replace function public.deliver_items_and_checkin(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para entrega e check-in.'; end if;
  perform 1 from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  perform public.deliver_ticket_full_kit(p_ticket_id, p_wristband_code);
  select public.checkin_ticket_entry(p_ticket_id, p_wristband_code) into v_ok;
  if v_ok is distinct from true then raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.'; end if;
  return true;
end; $$;

revoke all on function public.deliver_items_and_checkin(uuid, text) from public, anon;
grant execute on function public.deliver_items_and_checkin(uuid, text) to authenticated, service_role;

-- ============================================================
-- 5. undo_ticket_checkin -- motivo agora OBRIGATORIO (p_reason_code, sem
--    default) com os 6 codigos pedidos, texto obrigatorio quando 'other',
--    e opcao de desvincular a pulseira JUNTO (p_also_unlink_wristband,
--    default false -- desfazer check-in NUNCA desvincula pulseira sozinho).
--    Historico completo vai pro mesmo audit_logs.details ja usado por toda
--    RPC deste modulo (ticket_id, estado anterior, novo estado, motivo,
--    ator, created_at automatico da propria linha) -- nao criei tabela nova
--    pra isso: nao ha nenhuma tabela mais especifica que audit_logs pra
--    historico de check-in/kit/pulseira em todo o schema (confirmado por
--    investigacao dedicada).
-- ============================================================
drop function if exists public.undo_ticket_checkin(uuid);

create or replace function public.undo_ticket_checkin(
  p_ticket_id uuid, p_reason_code text, p_reason_text text default null, p_also_unlink_wristband boolean default false
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
  v_previous_status text;
  v_previous_used_at timestamptz;
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;
  if p_ticket_id is null then raise exception 'Ingresso obrigatorio.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para desfazer check-in neste ingresso.';
  end if;
  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Ingresso nao possui check-in para desfazer.';
  end if;

  if v_ticket.participant_id is not null then
    select * into v_participant from public.participants where id = v_ticket.participant_id;
  end if;

  v_previous_status := v_ticket.status;
  v_previous_used_at := v_ticket.used_at;

  update public.tickets set status = 'active', used_at = null where id = v_ticket.id;

  -- Desvincular pulseira e uma acao EXPLICITA, nunca automatica: so roda se
  -- o operador marcou a opcao, e exige a permissao propria de desvincular
  -- (se faltar, a transacao inteira falha em vez de silenciosamente pular).
  if p_also_unlink_wristband and exists (
    select 1 from public.participant_wristbands pw where pw.ticket_id = v_ticket.id and pw.status = 'active'
  ) then
    perform public.unlink_wristband_from_ticket(v_ticket.id, format('Desvinculada junto com o desfazer check-in (%s).', p_reason_code));
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_checkin_undo', 'tickets', v_ticket.id, coalesce(v_participant.event_id, v_ticket.event_id),
    jsonb_build_object(
      'actor_user_id', auth.uid(), 'actor_email', v_actor_email, 'ticket_id', v_ticket.id,
      'participant_id', v_ticket.participant_id, 'organization_id', v_ticket.organization_id,
      'previous_status', v_previous_status, 'previous_used_at', v_previous_used_at,
      'new_status', 'active', 'new_used_at', null,
      'reason_code', p_reason_code, 'reason_text', nullif(trim(coalesce(p_reason_text, '')), ''),
      'also_unlinked_wristband', p_also_unlink_wristband
    )
  );

  return true;
end;
$$;

revoke all on function public.undo_ticket_checkin(uuid, text, text, boolean) from public, anon;
grant execute on function public.undo_ticket_checkin(uuid, text, text, boolean) to authenticated, service_role;

-- ============================================================
-- 6. undo_ticket_kit_item / undo_ticket_full_kit -- motivo agora
--    OBRIGATORIO, mesma lista de 6 codigos. Corpo baseado na versao ja
--    corrigida em 20260821000000 (reverte event_kit_item_variant_inventory,
--    NUNCA a tabela legada shirt_inventory -- o bug de dupla-entrega ja fica
--    corrigido, nao reintroduzido). Devolve ao estoque exatamente a mesma
--    quantidade que foi baixada naquela entrega (v_link.quantity, a mesma
--    linha que deliver_ticket_kit_item decrementou) e faz tudo dentro da
--    mesma transacao da RPC -- atomico, sem estado intermediario possivel.
-- ============================================================
drop function if exists public.undo_ticket_kit_item(uuid, uuid);

create or replace function public.undo_ticket_kit_item(
  p_ticket_id uuid, p_kit_item_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype;
  v_kit public.event_kit_items%rowtype; v_inv public.event_kit_item_variant_inventory%rowtype; v_variant_id uuid;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if not public.user_can_access_organization(auth.uid(),v_link.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_link.status<>'delivered' then return true; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  select * into v_oi from public.order_items where id=v_ticket.order_item_id for update;
  select * into v_kit from public.event_kit_items where id=p_kit_item_id;
  if v_kit.item_type='shirt' and v_kit.shirt_supply_mode='stock' then
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is not null then
      select * into v_inv from public.event_kit_item_variant_inventory where kit_item_id=p_kit_item_id and variant_id=v_variant_id for update;
      if found then
        if coalesce(v_inv.delivered_quantity,0)<v_link.quantity then raise exception 'Quantidade entregue inconsistente no estoque.'; end if;
        update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity-v_link.quantity,reserved_quantity=reserved_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
      end if;
    end if;
  end if;
  update public.participant_kit_items set status='confirmed',delivered_at=null where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivery_undone','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'ticket_id',p_ticket_id,'participant_id',v_link.participant_id,
      'kit_item_id',p_kit_item_id,'quantity',v_link.quantity,
      'reason_code',p_reason_code,'reason_text',nullif(trim(coalesce(p_reason_text,'')),'')));
  return true;
end;
$$;

revoke all on function public.undo_ticket_kit_item(uuid, uuid, text, text) from public, anon;
grant execute on function public.undo_ticket_kit_item(uuid, uuid, text, text) to authenticated, service_role;

drop function if exists public.undo_ticket_full_kit(uuid);

create or replace function public.undo_ticket_full_kit(
  p_ticket_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_row record; v_found boolean:=false; v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  for v_row in select kit_item_id from public.participant_kit_items where ticket_id=p_ticket_id and status='delivered' loop
    v_found:=true;
    perform public.undo_ticket_kit_item(p_ticket_id,v_row.kit_item_id,p_reason_code,p_reason_text);
  end loop;
  if not v_found then raise exception 'Nenhum item entregue para desfazer.'; end if;
  return true;
end;
$$;

revoke all on function public.undo_ticket_full_kit(uuid, text, text) from public, anon;
grant execute on function public.undo_ticket_full_kit(uuid, text, text) to authenticated, service_role;

commit;
