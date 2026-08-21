-- Concessao administrativa contact-first. A identidade canonica e
-- registration_contacts; ticket/participant permanecem apenas projecoes
-- opcionais para compatibilidade operacional.
begin;

alter table public.store_orders
  alter column user_id drop not null,
  add column if not exists registration_contact_id uuid references public.registration_contacts(id) on delete restrict;

create index if not exists store_orders_registration_contact_id_idx
  on public.store_orders(registration_contact_id, created_at desc);

-- Pedidos publicos ja resolvem participant_id quando a conta possui uma
-- participacao no evento. Este trigger apenas projeta a identidade canonica
-- correspondente, sem criar participant/contact e sem alterar o checkout.
create or replace function public.sync_store_order_registration_contact()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if new.registration_contact_id is null and new.participant_id is not null then
    select p.registration_contact_id into new.registration_contact_id
    from public.participants p
    where p.id = new.participant_id and p.organization_id = new.organization_id and p.event_id = new.event_id;
  end if;
  return new;
end; $$;

drop trigger if exists trg_sync_store_order_registration_contact on public.store_orders;
create trigger trg_sync_store_order_registration_contact
before insert or update of participant_id, registration_contact_id on public.store_orders
for each row execute function public.sync_store_order_registration_contact();

update public.store_orders so
set registration_contact_id = p.registration_contact_id
from public.participants p
where so.registration_contact_id is null and so.participant_id = p.id
  and p.organization_id = so.organization_id and p.event_id = so.event_id
  and p.registration_contact_id is not null;

create or replace function public.admin_grant_store_item_to_contact(
  p_contact_id uuid, p_event_id uuid, p_store_item_id uuid, p_variant_id uuid,
  p_quantity integer, p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_contact public.registration_contacts%rowtype; v_event public.events%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_participant_id uuid; v_user_id uuid; v_unit_price numeric; v_final_unit_price numeric;
  v_line_total numeric; v_order_id uuid; v_order_number text; v_item_id uuid;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not (
    public.current_user_has_permission('store.grant_items')
    or public.current_user_has_permission('store.manage')
  ) then raise exception 'Sem permissao para conceder itens da loja.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;

  select * into v_contact from public.registration_contacts where id = p_contact_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Cadastro invalido ou sem acesso.';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found or v_event.organization_id <> v_contact.organization_id
    or not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido, de outra organizacao ou sem acesso.';
  end if;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and organization_id = v_contact.organization_id and (event_id = p_event_id or event_id is null) and is_active;
  if not found then raise exception 'Item da loja indisponivel para este evento ou organizacao.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Item exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants
      where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o item.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_final_unit_price := public.compute_store_item_final_price(v_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  -- Helper canonico: usa store_item_inventory para produto proprio e
  -- event_kit_item_variant_inventory para produto vinculado ao kit.
  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  select p.id, p.user_id into v_participant_id, v_user_id
  from public.participants p
  where p.registration_contact_id = p_contact_id and p.event_id = p_event_id
  order by p.created_at desc limit 1;

  v_line_total := case when coalesce(p_is_courtesy, false) then 0 else round(v_final_unit_price * p_quantity, 2) end;
  v_order_number := 'ADMIN-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (
    organization_id, event_id, user_id, participant_id, registration_contact_id,
    order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at
  ) values (
    v_contact.organization_id, p_event_id, v_user_id, v_participant_id, v_contact.id,
    v_order_number, case when coalesce(p_is_courtesy, false) then 'confirmed' else 'pending' end,
    case when coalesce(p_is_courtesy, false) then 'admin_courtesy' else 'admin_charge' end,
    case when coalesce(p_is_courtesy, false) then 'paid' else 'pending' end,
    v_line_total, v_line_total, nullif(trim(coalesce(p_reason, '')), ''),
    case when coalesce(p_is_courtesy, false) then now() end
  ) returning id into v_order_id;

  insert into public.store_order_items (
    store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status,
    discount_type, discount_value, final_unit_price
  ) values (
    v_order_id, v_store_item.id, p_variant_id, p_quantity,
    case when coalesce(p_is_courtesy, false) then 0 else v_unit_price end, v_line_total,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end,
    v_store_item.discount_type, v_store_item.discount_value,
    case when coalesce(p_is_courtesy, false) then 0 else v_final_unit_price end
  ) returning id into v_item_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('store_item_admin_granted', 'store_order_items', v_item_id, p_event_id,
    jsonb_build_object('actor_user_id', v_actor, 'actor_email', v_actor_email,
      'registration_contact_id', v_contact.id, 'participant_id', v_participant_id,
      'store_order_id', v_order_id, 'store_item_id', v_store_item.id, 'store_item_name', v_store_item.name,
      'variant_id', p_variant_id, 'quantity', p_quantity, 'is_courtesy', coalesce(p_is_courtesy, false),
      'unit_price', v_unit_price, 'final_amount', v_line_total, 'origin', 'admin_contact',
      'reason', nullif(trim(coalesce(p_reason,'')),''), 'linked_event_kit_item_id', v_store_item.linked_event_kit_item_id));
  return v_item_id;
end; $$;

revoke all on function public.admin_grant_store_item_to_contact(uuid, uuid, uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.admin_grant_store_item_to_contact(uuid, uuid, uuid, uuid, integer, boolean, text) to authenticated, service_role;

-- Wrapper ticket-first mantido para a Central de Operacoes. Ele nao cria
-- identidade: resolve o registration_contact ja canonico do ingresso e
-- delega estoque, preco, pedido e auditoria ao caminho contact-first.
create or replace function public.admin_grant_store_item(
  p_ticket_id uuid, p_store_item_id uuid, p_variant_id uuid, p_quantity integer,
  p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype;
  v_contact_id uuid; v_item_id uuid;
begin
  if v_actor is null or not (
    public.current_user_has_permission('store.grant_items')
    or public.current_user_has_permission('store.manage')
  ) then raise exception 'Sem permissao para conceder itens da loja.'; end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;
  select * into v_oi from public.order_items where id = v_ticket.order_item_id;
  v_contact_id := v_oi.registration_contact_id;
  if v_contact_id is null then
    select p.registration_contact_id into v_contact_id from public.participants p
    where p.id = coalesce(v_oi.participant_id, v_ticket.participant_id);
  end if;
  if v_contact_id is null then raise exception 'Ingresso sem cadastro global vinculado.'; end if;

  v_item_id := public.admin_grant_store_item_to_contact(v_contact_id, v_ticket.event_id,
    p_store_item_id, p_variant_id, p_quantity, p_is_courtesy, p_reason);
  update public.audit_logs set details = details || jsonb_build_object('ticket_id', v_ticket.id)
    where action = 'store_item_admin_granted' and entity_type = 'store_order_items' and entity_id = v_item_id;
  return v_item_id;
end; $$;

revoke all on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) to authenticated, service_role;

commit;
