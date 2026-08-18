-- NEXORA/Militrin: 4 correcoes pontuais e comprovadas encontradas na
-- homologacao real de Retirada/Central de Operacoes/Kits/Check-in. Nenhuma
-- regra de negocio nova, nenhum redesign -- so corrige comportamento
-- comprovadamente quebrado por reproducao real (RPC direta + testes de
-- concorrencia), com o minimo de mudanca em cada funcao. Nada de checkout,
-- pricing, patrocinadores, financeiro, importacoes ou maioridade foi
-- tocado.
begin;

-- ============================================================
-- 1. admin_change_ticket_shirt -- reserva de camiseta nao contava as
--    reservas de OUTROS ingressos pro mesmo estoque, so o que ja foi
--    entregue. Reproduzido: duas trocas de camiseta concorrentes pra
--    ultima unidade de uma variante -- a primeira reserva com sucesso, a
--    segunda nao recebe o SHIRT_OUT_OF_STOCK amigavel (que a propria
--    funcao ja sabe levantar): ela quebra com um erro cru do Postgres
--    (23514, violacao do check constraint reserved+delivered<=total) na
--    hora do UPDATE, porque a pre-checagem so olhava total-delivered.
--    Corrigido para descontar reserved_quantity tambem QUANDO a variante
--    esta realmente mudando (reserva nova) -- reatribuir a MESMA variante
--    que o proprio ingresso ja tinha continua usando a checagem simples de
--    antes (nao ha reserva nova sendo consumida nesse caso, e descontar a
--    propria reserva bloquearia incorretamente uma operacao sem efeito).
-- ============================================================

create or replace function public.admin_change_ticket_shirt("p_ticket_id" uuid, "p_new_shirt_type" text, "p_new_shirt_size" text) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  -- Apos a 137, esta chamada tambem enriquece vinculos legados de camiseta
  -- sem variant_id antes de ajustar os contadores agregados de reserva.
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_change_ticket_shirt');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;
  if found and v_link.status='delivered' then raise exception 'Camiseta ja entregue; use operacao explicita de troca ou estorno.'; end if;
  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_item.shirt_supply_mode='stock' then
    select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if v_old_variant is distinct from v_variant.id then
      if not found or v_new_inv.total_quantity-v_new_inv.delivered_quantity-v_new_inv.reserved_quantity<v_qty then
        raise exception using errcode='P0001',message='SHIRT_OUT_OF_STOCK',detail=jsonb_build_object(
          'code','SHIRT_OUT_OF_STOCK','shirt_type',v_variant.name,'shirt_size',v_variant.value,
          'physical_available',greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0)-coalesce(v_new_inv.reserved_quantity,0),0),
          'message',format('Nao ha estoque disponivel para %s %s. A troca nao foi confirmada.',v_variant.name,v_variant.value))::text;
      end if;
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    else
      if not found or v_new_inv.total_quantity-v_new_inv.delivered_quantity<v_qty then
        raise exception using errcode='P0001',message='SHIRT_OUT_OF_STOCK',detail=jsonb_build_object(
          'code','SHIRT_OUT_OF_STOCK','shirt_type',v_variant.name,'shirt_size',v_variant.value,
          'physical_available',greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0),
          'message',format('Nao ha estoque disponivel para %s %s. A troca nao foi confirmada.',v_variant.name,v_variant.value))::text;
      end if;
    end if;
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
-- 2. undo_ticket_kit_item -- desfazer a entrega de uma camiseta gravava a
--    devolucao de estoque na tabela LEGADA `shirt_inventory` (chave
--    event_id+shirt_type+shirt_size em texto), enquanto a entrega real
--    (deliver_ticket_kit_item) sempre le/escreve em
--    `event_kit_item_variant_inventory` (chave kit_item_id+variant_id).
--    Reproduzido: entregar uma camiseta, desfazer a entrega (delivered_at
--    volta a null, status volta a 'confirmed' -- aparenta ter funcionado),
--    entregar de novo -- o estoque real (event_kit_item_variant_inventory)
--    nunca foi decrementado no undo, entao a segunda entrega soma
--    delivered_quantity=2 pra uma unica camiseta fisica realmente entregue
--    uma vez. Corrigido para usar a MESMA tabela/chave que a entrega usa.
-- ============================================================

create or replace function public.undo_ticket_kit_item("p_ticket_id" uuid, "p_kit_item_id" uuid) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_kit public.event_kit_items%rowtype; v_inv public.event_kit_item_variant_inventory%rowtype; v_variant_id uuid;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
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
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivery_undone','participant_kit_items',v_link.id,v_link.event_id,jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'participant_id',v_link.participant_id,'kit_item_id',p_kit_item_id,'quantity',v_link.quantity));
  return true;
end;
$$;

-- ============================================================
-- 3. get_ticket_shirt_stock -- quando a camiseta do ingresso nunca foi
--    vinculada a uma variante (variant_id ausente -- dado legado ou
--    pendencia), a funcao devolvia status='out_of_stock' com
--    shirt_type/shirt_size em branco, indistinguivel de um esgotamento
--    real de estoque para quem le a tela. Reproduzido inserindo um
--    participant_kit_items de camiseta sem variant_id: a tela mostraria
--    "SEM ESTOQUE" quando o problema real e "ninguem escolheu o tamanho".
--    Corrigido com um status distinto ('not_defined') exatamente pra esse
--    caso, sem inventar estoque zero.
-- ============================================================

create or replace function public.get_ticket_shirt_stock("p_ticket_id" uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_ticket public.tickets%rowtype; v_row record; v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.view') then raise exception 'Sem permissao para consultar ingresso.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select pki.status,pki.quantity,eki.shirt_supply_mode,v.name as shirt_type,v.value as shirt_size,
    inv.total_quantity,inv.delivered_quantity
  into v_row
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
  left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=pki.kit_item_id and inv.variant_id=v.id
  where pki.ticket_id=p_ticket_id order by pki.created_at limit 1;
  if not found then return null; end if;
  v_available:=case when v_row.shirt_supply_mode='stock' then greatest(coalesce(v_row.total_quantity,0)-coalesce(v_row.delivered_quantity,0),0) else null end;
  return jsonb_build_object('shirt_type',coalesce(v_row.shirt_type,''),'shirt_size',coalesce(v_row.shirt_size,''),
    'supply_mode',coalesce(v_row.shirt_supply_mode,''),'physical_available',v_available,
    'status',case
      when v_row.status='delivered' or v_row.shirt_supply_mode<>'stock' then 'not_applicable'
      when v_row.shirt_type is null then 'not_defined'
      when v_available=0 then 'out_of_stock' when v_available=1 then 'last_unit' else 'available' end);
end; $$;

-- ============================================================
-- 4. RLS de order_items -- so existiam policies de autoatendimento
--    (comprador/titular/proprietario veem so os proprios registros).
--    Nao havia NENHUMA policy dando acesso a staff/operador pela
--    organizacao -- diferente de `tickets`, que ja tem
--    tickets_rbac_select exatamente pra isso. Reproduzido: a busca por
--    nome/CPF de "/retirada" (searchPickupParticipantAction, que consulta
--    order_items direto via REST, nao por RPC) devolvia sempre "Pessoa
--    encontrada, mas sem ingresso elegivel" pra um administrador/owner
--    reais, mesmo com os ingressos existindo e visiveis via service_role
--    -- a pessoa era achada (registration_contacts tem policy propria),
--    mas o join ate os tickets dela ficava vazio porque a leitura de
--    order_items era barrada pelo RLS. Corrigido espelhando exatamente a
--    mesma condicao ja usada em tickets_rbac_select.
-- ============================================================

create policy "order_items_rbac_select" on public.order_items for select
using (
  public.is_platform_owner(auth.uid())
  or (
    (
      public.is_active_owner(auth.uid())
      or public.resolve_user_permission(auth.uid(), 'orders.view')
      or public.resolve_user_permission(auth.uid(), 'participants.view')
      or public.resolve_user_permission(auth.uid(), 'checkin.view')
      or public.resolve_user_permission(auth.uid(), 'checkin.scan')
      or public.resolve_user_permission(auth.uid(), 'checkin.undo')
      or public.resolve_user_permission(auth.uid(), 'kits.view')
      or public.resolve_user_permission(auth.uid(), 'kits.deliver')
    )
    and exists (
      select 1 from public.orders o
      where o.id = order_items.order_id
        and public.user_can_access_organization(auth.uid(), o.organization_id)
    )
  )
);

commit;
