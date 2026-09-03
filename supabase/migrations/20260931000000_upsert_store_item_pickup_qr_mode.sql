-- FEATURE (3/10): upsert_store_item ganha p_pickup_qr_mode, pra expor a
-- config de "QR de retirada" (per_unit/per_line/none) na tela de admin de
-- produtos (Loja > Produtos > Editar produto). Assinatura muda -- precisa
-- de drop explicito (mesma disciplina ja usada em 20260855000000 pra
-- acrescentar p_discount_type/p_discount_value).
begin;

drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid, text, numeric);

create function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer,
  p_supply_mode text default 'stock', p_available_all_events boolean default false,
  p_visibility text default 'public', p_linked_event_kit_item_id uuid default null,
  p_discount_type text default null, p_discount_value numeric default 0,
  p_pickup_qr_mode text default 'per_line'
) returns uuid
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
  v_kit_item public.event_kit_items%rowtype; v_requires_variant boolean; v_previous_link uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;
  if coalesce(p_visibility, 'public') not in ('public', 'code_required', 'admin_only') then raise exception 'Visibilidade invalida: %.', p_visibility; end if;
  if coalesce(p_pickup_qr_mode, 'per_line') not in ('per_unit', 'per_line', 'none') then raise exception 'Modo de QR de retirada invalido: %.', p_pickup_qr_mode; end if;
  perform public.validate_store_item_discount(p_price, p_discount_type, p_discount_value);

  if p_id is not null then
    select * into v_existing from public.store_items where id = p_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_existing.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
    v_org := v_existing.organization_id;
    v_previous_link := v_existing.linked_event_kit_item_id;
  elsif p_event_id is not null then
    select * into v_event from public.events where id = p_event_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
    v_org := v_event.organization_id;
  else
    v_org := public.current_organization_id();
    if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then raise exception 'Nao foi possivel identificar a organizacao do usuario.'; end if;
  end if;

  v_requires_variant := coalesce(p_requires_variant, false);

  if p_linked_event_kit_item_id is not null then
    select * into v_kit_item from public.event_kit_items where id = p_linked_event_kit_item_id;
    if not found then raise exception 'Item de kit invalido para vincular.'; end if;
    select organization_id into v_org from public.events where id = v_kit_item.event_id;
    if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
      raise exception 'Item de kit invalido ou sem acesso.';
    end if;
    v_stored_event_id := v_kit_item.event_id;
    v_requires_variant := true;

    if p_id is not null and v_previous_link is null and exists (
      select 1 from public.store_item_inventory
      where store_item_id = p_id and (total_quantity > 0 or reserved_quantity > 0 or delivered_quantity > 0)
    ) then
      raise exception 'Este item ja possui estoque proprio configurado (quantidade, reserva ou entrega). Nao e possivel vincular automaticamente ao estoque de um evento -- zere o estoque proprio primeiro ou cadastre um novo produto vinculado.';
    end if;

    if p_id is not null and v_previous_link is not null and p_linked_event_kit_item_id is distinct from v_previous_link and exists (
      select 1 from public.store_order_items soi join public.store_item_variants siv on siv.id = soi.variant_id
      where soi.store_item_id = p_id and siv.linked_event_kit_item_variant_id is not null and soi.status <> 'cancelled'
    ) then
      raise exception 'Este item ja possui pedidos ou concessoes usando o vinculo atual. Nao e possivel trocar o item de kit vinculado automaticamente -- cadastre um novo produto para o novo vinculo.';
    end if;
  else
    if p_id is not null and v_previous_link is not null and exists (
      select 1 from public.store_order_items soi join public.store_item_variants siv on siv.id = soi.variant_id
      where soi.store_item_id = p_id and siv.linked_event_kit_item_variant_id is not null and soi.status <> 'cancelled'
    ) then
      raise exception 'Este item ja possui pedidos ou concessoes usando o estoque compartilhado do evento. Nao e possivel desvincular automaticamente -- cadastre um novo produto para estoque proprio, se necessario.';
    end if;
    v_stored_event_id := case when coalesce(p_available_all_events, false) then null else p_event_id end;
    if v_stored_event_id is not null then
      select * into v_event from public.events where id = v_stored_event_id;
      if not found or v_event.organization_id <> v_org then raise exception 'Evento invalido para este item.'; end if;
    end if;
  end if;

  if p_id is null then
    insert into public.store_items (organization_id, event_id, name, slug, description, price, requires_variant, is_active, sort_order, supply_mode, visibility, linked_event_kit_item_id, discount_type, discount_value, pickup_qr_mode)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''),
      p_price, v_requires_variant, coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'), coalesce(p_visibility, 'public'), p_linked_event_kit_item_id,
      p_discount_type, coalesce(p_discount_value, 0), coalesce(p_pickup_qr_mode, 'per_line'))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = v_requires_variant, is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), visibility = coalesce(p_visibility, 'public'),
      linked_event_kit_item_id = p_linked_event_kit_item_id, discount_type = p_discount_type, discount_value = coalesce(p_discount_value, 0),
      pickup_qr_mode = coalesce(p_pickup_qr_mode, 'per_line'),
      updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;

  if p_linked_event_kit_item_id is not null and p_linked_event_kit_item_id is distinct from v_previous_link then
    perform public.sync_linked_store_item_variants(v_id);
  end if;

  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid, text, numeric, text) to authenticated, service_role;
revoke all on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid, text, numeric, text) from anon;

commit;
