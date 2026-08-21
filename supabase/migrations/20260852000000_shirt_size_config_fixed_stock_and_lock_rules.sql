-- Fecha as regras de camiseta do Militrin, substituindo as configuracoes
-- pouco claras "Alteracao permitida"/"Controlar estoque por opcao" por
-- exatamente duas, conforme especificado:
--   A) "Permitir alteracao de tamanho pelo usuario"  -> ja existe:
--      event_kit_items.allow_participant_change (nao duplicado).
--   B) "Permitir escolha de tamanho somente se tiver estoque" -> ja existe
--      como conceito: event_kit_items.shirt_supply_mode ('stock' quando B=
--      true, 'made_to_order' quando B=false). Nao foi criado nenhum campo
--      novo -- so passou a existir uma forma de o admin CONTROLAR esse campo
--      pela tela de configuracao (antes so era setado na criacao do item).
--
-- Controle de estoque por tamanho (event_kit_item_variant_inventory, 1 linha
-- por variante) SEMPRE existiu como estrutura -- nunca teve um checkbox pra
-- "ligar/desligar". O que este arquivo fecha e o COMPORTAMENTO ao redor
-- dela, pra bater com a regra definitiva:
--
-- 1) admin_change_ticket_shirt (RPC canonica de troca/definicao de camiseta,
--    usada por TODOS os chamadores -- retirada, operacoes, importacao,
--    autoatendimento via review_ticket_item_change_request/resolve_ticket_
--    data_issues) trava com o novo erro estruturado
--    SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION assim que o ingresso tiver
--    check-in feito OU kit entregue -- antes so barrava kit entregue, nunca
--    check-in. Isso fecha a regra 5 (trava apos kit OU check-in) em todos os
--    fluxos normais de uma vez, sem duplicar a checagem em cada chamador.
-- 2) admin_change_ticket_shirt passa a garantir a linha de estoque da
--    variante escolhida (e mover reserved_quantity) independente do modo
--    (stock ou made_to_order) -- controle por tamanho e regra fixa, entao a
--    reserva de demanda tambem precisa existir nos dois modos. So a
--    DISPONIBILIDADE FISICA bloqueia a ESCOLHA quando shirt_supply_mode=
--    'stock' (== configuracao B ligada); em made_to_order (B desligada) a
--    escolha continua sempre permitida, exatamente como decidido na
--    20260824000000.
-- 3) deliver_ticket_kit_item/deliver_ticket_full_kit passam a validar estoque
--    fisico SEMPRE que o item e camiseta (stock OU made_to_order) -- antes
--    so validavam em 'stock'. Fecha a regra 4: a config B nunca muda o
--    comportamento da ENTREGA -- estoque 0 sempre bloqueia a entrega fisica,
--    nos dois modos.
-- 4) undo_ticket_kit_item e admin_cancel_ticket passam a reverter/liberar
--    estoque tambem em made_to_order (nao so 'stock'), simetrico ao item 3 --
--    sem isso, desfazer uma entrega ou cancelar um ingresso made_to_order
--    deixaria delivered_quantity/reserved_quantity com sobra fantasma depois
--    que a entrega passou a decrementar estoque tambem nesse modo.
-- 5) Nova RPC admin_correct_ticket_shirt_after_operation: o UNICO caminho
--    valido pra trocar tamanho depois de kit entregue ou check-in (regra 6).
--    Exige motivo (reutiliza validate_operation_reason_code/REASON_CODES, ja
--    usado por undo_ticket_checkin/undo_ticket_kit_item -- nao criou
--    catalogo de motivo duplicado), grava ator+timestamp+historico em
--    audit_logs (mesmo padrao ja usado em todo o modulo operacional -- nao
--    ha tabela mais especifica de historico de kit/camiseta em todo o
--    schema, confirmado por investigacao dedicada) e ajusta o estoque
--    fisico coerentemente SE havia impacto fisico real (kit ja entregue):
--    devolve a unidade do tamanho antigo e consome do tamanho novo, com o
--    mesmo bloqueio de estoque zero da entrega normal.
-- 6) set_event_kit_item_change_rules ganha o 4o parametro
--    p_require_stock_for_choice, que so tem efeito em kit items do tipo
--    'shirt' (grava em shirt_supply_mode). Para outros tipos de item o
--    comportamento fica IDENTICO ao de antes (p_track_inventory continua
--    valendo) -- esta correcao e especificamente sobre CAMISETA, os outros
--    tipos de item de kit nao sao alterados.
begin;

-- ============================================================
-- 1) admin_change_ticket_shirt -- trava apos kit OU check-in, reserva
--    sempre (nos dois modos), disponibilidade fisica so bloqueia a escolha
--    quando shirt_supply_mode='stock'.
-- ============================================================
create or replace function public.admin_change_ticket_shirt(p_ticket_id uuid, p_new_shirt_type text, p_new_shirt_size text) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid; v_available integer;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_change_ticket_shirt');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;

  -- Regra 5: tamanho trava no fluxo normal apos kit entregue OU check-in
  -- realizado. Correcao depois disso exige admin_correct_ticket_shirt_after_
  -- operation, nunca esta RPC (mesmo pra admin).
  if (v_ticket.status='used' or v_ticket.used_at is not null) or (found and v_link.status='delivered') then
    raise exception using errcode='P0001', message='SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION',
      detail=jsonb_build_object('code','SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION',
        'message','O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado.')::text;
  end if;

  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;

  -- Controle de estoque por tamanho e regra fixa: a linha de inventario da
  -- variante escolhida passa a existir sempre, independente do modo.
  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
  values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_variant.id,0)
  on conflict(kit_item_id,variant_id) do nothing;
  select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;

  -- "Permitir escolha de tamanho somente se tiver estoque" (config B ==
  -- shirt_supply_mode='stock'): so aqui a ESCOLHA e bloqueada por estoque
  -- fisico zerado. Em made_to_order (B desligada) a escolha continua sempre
  -- permitida -- a entrega fisica e que continua bloqueando em zero, sempre,
  -- nos dois modos (ver item 3 abaixo).
  if v_item.shirt_supply_mode='stock' then
    v_available:=greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0);
    if v_available<v_qty then
      perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
    end if;
  end if;

  if v_old_variant is distinct from v_variant.id then
    if v_old_variant is not null then
      insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
      values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_old_variant,0)
      on conflict(kit_item_id,variant_id) do nothing;
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
    end if;
    update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
  end if;

  update public.order_items set shirt_type=v_variant.name,shirt_size=v_variant.value,updated_at=now() where id=v_oi.id;
  insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
  values(v_ticket.id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_ticket.organization_id,v_item.id,
    jsonb_build_object('variant_id',v_variant.id,'shirt_type',v_variant.name,'shirt_size',v_variant.value,'supply_mode',v_item.shirt_supply_mode),v_qty,'confirmed')
  on conflict(ticket_id,kit_item_id) where ticket_id is not null do update set variant_data=excluded.variant_data,quantity=excluded.quantity;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_admin_changed','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'kit_item_id',v_item.id,'variant_id',v_variant.id,'supply_mode',v_item.shirt_supply_mode));
  return true;
end; $$;

-- ============================================================
-- 2) deliver_ticket_kit_item / deliver_ticket_full_kit -- estoque fisico
--    zerado SEMPRE bloqueia a entrega de camiseta, nos dois modos (stock e
--    made_to_order). A config B nunca muda o comportamento da entrega.
-- ============================================================
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
    -- Estoque fisico zerado SEMPRE bloqueia a entrega -- independente da
    -- configuracao "somente se tiver estoque" (stock ou made_to_order).
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

  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id and status<>'delivered';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,
      'supply_mode',v_item.shirt_supply_mode,'variant_id',v_variant_id));
  return true;
end; $$;

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
  -- Estoque fisico zerado sempre bloqueia a entrega de camiseta, nos dois
  -- modos (stock e made_to_order) -- so 'disabled' fica fora da entrega.
  for v_row in
    select pki.kit_item_id,pki.quantity,v.id as variant_id,v.name as shirt_type,v.value as shirt_size
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id=pki.kit_item_id
    left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
    where pki.ticket_id=p_ticket_id and pki.status not in('delivered','cancelled')
      and eki.item_type='shirt' and eki.shirt_supply_mode in('stock','made_to_order')
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

-- ============================================================
-- 3) undo_ticket_kit_item -- reverte estoque tambem em made_to_order (nao so
--    'stock'), simetrico a entrega agora decrementar estoque nos dois modos.
-- ============================================================
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
  if v_kit.item_type='shirt' and v_kit.shirt_supply_mode in('stock','made_to_order') then
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

-- ============================================================
-- 4) admin_cancel_ticket -- libera reserved_quantity tambem em made_to_order.
--    "not found" nunca bloqueia o cancelamento (reserva legada anterior a
--    esta correcao pode nao ter linha de estoque ainda -- nao ha nada pra
--    liberar nesse caso, e isso NUNCA deve impedir cancelar o ingresso).
-- ============================================================
create or replace function public.admin_cancel_ticket(p_ticket_id uuid, p_reason text) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype; v_link record; v_variant uuid; v_inventory public.event_kit_item_variant_inventory%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('orders.cancel') then raise exception 'Sem permissao para cancelar ingresso.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',false); end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso com check-in; desfaça o check-in antes do cancelamento.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id for update;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if v_item.order_id is distinct from v_ticket.order_id or v_item.event_id is distinct from v_ticket.event_id
    or v_order.event_id is distinct from v_ticket.event_id or v_order.organization_id is distinct from v_ticket.organization_id then
    raise exception 'Cadeia comercial inconsistente para o ingresso.';
  end if;
  if exists(select 1 from public.participant_kit_items where ticket_id=v_ticket.id and status='delivered') then raise exception 'Ingresso possui item entregue; desfaça a entrega antes do cancelamento.'; end if;
  for v_link in select pki.*,eki.item_type,eki.track_variant_inventory,eki.shirt_supply_mode from public.participant_kit_items pki join public.event_kit_items eki on eki.id=pki.kit_item_id where pki.ticket_id=v_ticket.id and pki.status<>'cancelled' order by pki.id for update of pki loop
    v_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant is not null and (v_link.track_variant_inventory or (v_link.item_type='shirt' and v_link.shirt_supply_mode in('stock','made_to_order'))) then
      select * into v_inventory from public.event_kit_item_variant_inventory where kit_item_id=v_link.kit_item_id and variant_id=v_variant for update;
      if found then
        update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_link.quantity,0),updated_at=now() where id=v_inventory.id;
      end if;
    end if;
    update public.participant_kit_items set status='cancelled' where id=v_link.id;
  end loop;
  update public.tickets set status='cancelled',cancelled_at=coalesce(cancelled_at,now()) where id=v_ticket.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('admin_ticket_cancelled','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'reason',trim(p_reason)));
  return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',true);
end; $$;

-- ============================================================
-- 5) admin_correct_ticket_shirt_after_operation -- unico caminho valido pra
--    trocar tamanho depois de kit entregue ou check-in realizado (regra 6).
--    Motivo obrigatorio (mesmo catalogo de REASON_CODES ja usado pelas
--    RPCs de undo), ator+timestamp+historico em audit_logs, e ajuste
--    coerente de estoque quando ha impacto fisico real (kit ja entregue):
--    devolve a unidade do tamanho antigo e consome do tamanho novo, com o
--    mesmo bloqueio de estoque zero da entrega normal.
-- ============================================================
create or replace function public.admin_correct_ticket_shirt_after_operation(
  p_ticket_id uuid, p_new_shirt_type text, p_new_shirt_size text, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype;
  v_old_inv public.event_kit_item_variant_inventory%rowtype; v_new_inv public.event_kit_item_variant_inventory%rowtype;
  v_qty integer; v_old_variant uuid; v_was_delivered boolean; v_available integer;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para corrigir camiseta.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_correct_ticket_shirt_after_operation');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;

  -- Este e o UNICO caminho valido pra trocar tamanho depois de kit entregue
  -- ou check-in realizado -- se nenhum dos dois ocorreu ainda, a troca deve
  -- passar por admin_change_ticket_shirt (fluxo normal), nunca por aqui.
  if not ((v_ticket.status='used' or v_ticket.used_at is not null) or (found and v_link.status='delivered')) then
    raise exception 'Este ingresso ainda nao teve kit entregue nem check-in; use a troca normal de tamanho.';
  end if;

  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  v_was_delivered:=found and v_link.status='delivered';

  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
  values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_variant.id,0)
  on conflict(kit_item_id,variant_id) do nothing;
  select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;

  if v_old_variant is distinct from v_variant.id then
    if v_was_delivered then
      -- Impacto fisico real: devolve a unidade do tamanho antigo e consome
      -- do tamanho novo -- estoque 0 sempre bloqueia, igual a entrega normal.
      v_available:=greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0);
      if v_available<v_qty then
        perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
      end if;
      if v_old_variant is not null then
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
        if found then update public.event_kit_item_variant_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      end if;
      update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    else
      -- Sem entrega fisica ainda (so check-in feito, kit ainda pendente):
      -- ajusta apenas a reserva de demanda, sem mexer em delivered_quantity.
      if v_old_variant is not null then
        insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
        values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_old_variant,0)
        on conflict(kit_item_id,variant_id) do nothing;
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
        if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    end if;
  end if;

  update public.order_items set shirt_type=v_variant.name,shirt_size=v_variant.value,updated_at=now() where id=v_oi.id;
  update public.participant_kit_items set variant_data=jsonb_build_object('variant_id',v_variant.id,'shirt_type',v_variant.name,'shirt_size',v_variant.value,'supply_mode',v_item.shirt_supply_mode)
    where id=v_link.id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_admin_corrected_after_operation','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'actor_email',v_actor_email,'ticket_id',v_ticket.id,'kit_item_id',v_item.id,
      'previous_variant_id',v_old_variant,'new_variant_id',v_variant.id,'previous_shirt_type',v_oi.shirt_type,'previous_shirt_size',v_oi.shirt_size,
      'new_shirt_type',v_variant.name,'new_shirt_size',v_variant.value,'was_delivered',v_was_delivered,
      'reason_code',p_reason_code,'reason_text',nullif(trim(coalesce(p_reason_text,'')),'')));
  return true;
end; $$;

revoke all on function public.admin_correct_ticket_shirt_after_operation(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_correct_ticket_shirt_after_operation(uuid, text, text, text, text) to authenticated, service_role;

-- ============================================================
-- 6) set_event_kit_item_change_rules -- 4o parametro opcional, so afeta
--    kit items do tipo 'shirt' (grava em shirt_supply_mode). Para outros
--    tipos o comportamento permanece IDENTICO ao anterior.
-- ============================================================
drop function if exists public.set_event_kit_item_change_rules(uuid, boolean, boolean);

create or replace function public.set_event_kit_item_change_rules(
  p_kit_item_id uuid, p_allow_change boolean, p_track_inventory boolean, p_require_stock_for_choice boolean default null
) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$ declare v_event uuid; v_org uuid; v_item_type text; begin
  if auth.uid() is null or not public.current_user_has_permission('events.edit') then raise exception 'Sem permissao para configurar o item.'; end if;
  select eki.event_id,e.organization_id,eki.item_type into v_event,v_org,v_item_type from public.event_kit_items eki join public.events e on e.id=eki.event_id where eki.id=p_kit_item_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Item invalido ou sem acesso.'; end if;
  if v_item_type='shirt' then
    update public.event_kit_items set allow_participant_change=coalesce(p_allow_change,false),
      shirt_supply_mode=case when coalesce(p_require_stock_for_choice,true) then 'stock' else 'made_to_order' end,
      updated_at=now()
    where id=p_kit_item_id;
  else
    update public.event_kit_items set allow_participant_change=coalesce(p_allow_change,false),track_variant_inventory=coalesce(p_track_inventory,false),updated_at=now() where id=p_kit_item_id;
  end if;
  return true;
end; $$;

revoke all on function public.set_event_kit_item_change_rules(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_event_kit_item_change_rules(uuid, boolean, boolean, boolean) to authenticated, service_role;

commit;
