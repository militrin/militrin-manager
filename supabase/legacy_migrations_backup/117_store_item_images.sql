-- 117_store_item_images.sql
-- Adiciona imagem aos itens da Loja do Evento (nome de exibicao revisado de
-- "lojinha"). O bucket publico "store-item-images" ja foi criado via API
-- (supabase.storage.createBucket), nao precisa ser recriado aqui - esta
-- migration so adiciona a coluna, as policies de storage, e ajusta os nomes
-- das permissoes ja inseridas pela 116.

begin;

alter table public.store_items add column if not exists image_url text;

update public.admin_permissions set name = 'Ver loja do evento', description = 'Visualiza catalogo, estoque e pedidos da loja do evento' where code = 'store.view';
update public.admin_permissions set name = 'Gerenciar loja do evento', description = 'Cria/edita itens, variantes e estoque da loja do evento' where code = 'store.manage';
update public.admin_permissions set name = 'Entregar itens da loja', description = 'Registra entrega/desfazer entrega de itens comprados na loja do evento' where code = 'store.deliver';

drop policy if exists "store_item_images_public_read" on storage.objects;
create policy "store_item_images_public_read"
on storage.objects for select
using (bucket_id = 'store-item-images');

drop policy if exists "store_item_images_manage_insert" on storage.objects;
create policy "store_item_images_manage_insert"
on storage.objects for insert
to authenticated
with check (bucket_id = 'store-item-images' and public.current_user_has_permission('store.manage'));

drop policy if exists "store_item_images_manage_update" on storage.objects;
create policy "store_item_images_manage_update"
on storage.objects for update
to authenticated
using (bucket_id = 'store-item-images' and public.current_user_has_permission('store.manage'));

drop policy if exists "store_item_images_manage_delete" on storage.objects;
create policy "store_item_images_manage_delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'store-item-images' and public.current_user_has_permission('store.manage'));

-- Mudou a lista de colunas de retorno (image_url no meio); precisa dropar,
-- CREATE OR REPLACE nao permite alterar o tipo de retorno de uma funcao.
drop function if exists public.list_store_items_for_event(uuid);

create or replace function public.list_store_items_for_event(p_event_id uuid)
returns table (
  store_item_id uuid, name text, slug text, description text, image_url text, price numeric, requires_variant boolean,
  sort_order integer, variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.name, si.slug, si.description, si.image_url, si.price, si.requires_variant, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where si.event_id = p_event_id and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to authenticated, anon;

-- A assinatura mudou (novo parametro p_image_url no meio); precisa dropar a
-- versao antiga, senao create or replace cria uma segunda funcao sobrecarregada.
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer);

create or replace function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text, p_image_url text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer
)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;

  if p_id is null then
    insert into public.store_items (event_id, name, slug, description, image_url, price, requires_variant, is_active, sort_order)
    values (p_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_image_url, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.store_items set
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      image_url = nullif(trim(coalesce(p_image_url, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), updated_at = now()
    where id = p_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da lojinha nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer) to authenticated;

commit;
