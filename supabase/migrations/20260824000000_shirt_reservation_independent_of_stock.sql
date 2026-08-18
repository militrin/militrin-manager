-- Regra de negocio confirmada explicitamente: reserva/demanda de camiseta e
-- INDEPENDENTE do estoque fisico disponivel. Uma pessoa pode ter "Normal G"
-- vinculada ao ingresso mesmo com 0 unidades fisicas G no momento (as
-- camisetas ainda serao encomendadas/recebidas). O estoque fisico so deve
-- bloquear a ENTREGA/RETIRADA efetiva, nunca a reserva.
--
-- Causa raiz encontrada ao investigar o caminho conflito de importacao ->
-- resolve_ticket_data_issues -> admin_change_ticket_shirt: a RPC canonica de
-- troca/definicao de camiseta (usada por TODOS os chamadores -- retirada,
-- operacoes, importacao, autoatendimento de pendencia via change_ticket_shirt
-- que e so um wrapper dela) bloqueava a propria RESERVA com SHIRT_OUT_OF_STOCK
-- sempre que total_quantity-delivered_quantity(-reserved_quantity) fosse
-- insuficiente -- tratando estoque fisico como teto de demanda, nao so de
-- entrega. Alem disso, a constraint de banco
-- event_kit_item_variant_inventory_check exigia
-- (reserved_quantity+delivered_quantity)<=total_quantity, o que tornaria
-- IMPOSSIVEL reservar acima do estoque fisico mesmo se a RPC nao bloqueasse.
--
-- Correcao na fonte canonica (nao e um workaround de importacao -- afeta
-- igualmente retirada, operacoes, autoatendimento e importacao, todos
-- chamadores de admin_change_ticket_shirt/change_ticket_shirt):
-- 1) Remove a constraint que somava reserved+delivered contra total_quantity.
--    Mantida intacta a constraint separada e correta
--    event_kit_item_variant_inventory_physical_stock_bounds
--    (delivered_quantity<=total_quantity) -- essa sim e a garantia fisica
--    real (nunca entregar mais do que existe fisicamente).
-- 2) admin_change_ticket_shirt para de checar estoque fisico ao RESERVAR
--    (tanto reatribuir pra uma variante nova quanto reconfirmar a mesma) --
--    so ajusta reserved_quantity, sempre. Se a linha de inventario da
--    variante ainda nao existir (nunca teve estoque configurado, nem "0"),
--    ela e criada com total_quantity=0 em vez de erro -- reservar demanda
--    para uma variante ainda sem estoque cadastrado precisa funcionar.
-- 3) deliver_ticket_kit_item, deliver_ticket_full_kit e undo_ticket_kit_item
--    NAO SAO ALTERADAS -- a entrega fisica continua exigindo
--    total_quantity-delivered_quantity>=quantidade, exatamente como antes.
begin;

alter table public.event_kit_item_variant_inventory
  drop constraint if exists event_kit_item_variant_inventory_check;

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
    -- Reserva/demanda e independente do estoque fisico: garante que a linha
    -- de inventario exista (mesmo com total_quantity=0, "ainda nao chegou")
    -- e so move reserved_quantity, sem checar disponibilidade fisica.
    insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
    values(v_ticket.organization_id,v_ticket.event_id,v_item.id,v_variant.id,0)
    on conflict(kit_item_id,variant_id) do nothing;
    select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if v_old_variant is distinct from v_variant.id then
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
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

commit;
