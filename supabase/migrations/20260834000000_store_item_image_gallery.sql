-- Galeria de imagens de produto.
--
-- Ate aqui store_items tinha 1 coluna image_url, usada como fonte tanto
-- pelo card/modal da loja (AccountStoreShop/ItemDetailModal, via
-- get-store-items.ts) quanto pelo card "Compre junto" do carrinho de
-- inscricao (cart-step.tsx, via list_store_items_for_event direto). Esta
-- migration troca essa fonte por N imagens ordenadas com 1 principal,
-- reaproveitando o bucket de storage "store-item-images" ja existente
-- (so que agora criado de forma reproduzivel, como sponsor-banners) e o
-- mesmo padrao de RLS "select liberado, escrita so via RPC security
-- definer" ja usado em store_items/store_item_variants/store_item_inventory.
--
-- Compatibilidade: todo image_url ja cadastrado vira a imagem principal
-- (is_primary=true, sort_order=0) do respectivo item antes da coluna
-- antiga ser removida -- nenhuma imagem e perdida. Depois do backfill,
-- store_item_images passa a ser a UNICA fonte de imagem de produto: as
-- funcoes que liam si.image_url (list_store_items_for_event,
-- upsert_store_item, get_organization_coupon_scope_options,
-- get_cart_order_details) sao reescritas para ler da imagem principal
-- desta tabela antes da coluna ser dropada, para nao deixar duas fontes
-- conflitantes.
begin;

-- ============================================================
-- 1. Tabela store_item_images
-- ============================================================

create table if not exists public.store_item_images (
  id uuid primary key default gen_random_uuid(),
  store_item_id uuid not null references public.store_items(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  image_url text not null,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_store_item_images_item_sort on public.store_item_images (store_item_id, sort_order);
-- No maximo 1 imagem principal por item.
create unique index if not exists ux_store_item_images_one_primary on public.store_item_images (store_item_id) where is_primary;

alter table public.store_item_images enable row level security;

drop policy if exists "store_item_images_select" on public.store_item_images;
create policy "store_item_images_select" on public.store_item_images for select to authenticated
  using (exists (select 1 from public.store_items si where si.id = store_item_images.store_item_id));
-- Nenhuma policy de insert/update/delete: escrita so via RPCs abaixo (mesmo
-- padrao de store_items/store_item_variants/store_item_inventory).

create or replace function public.trg_store_item_images_set_org() returns trigger
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.store_items where id = NEW.store_item_id;
  if not found or v_org is null then raise exception 'Item da loja % nao encontrado ou sem organization_id.', NEW.store_item_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_item_images (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;

drop trigger if exists trg_store_item_images_org on public.store_item_images;
create trigger trg_store_item_images_org before insert or update on public.store_item_images
  for each row execute function public.trg_store_item_images_set_org();

-- ============================================================
-- 2. Backfill: image_url atual vira a imagem principal.
-- ============================================================

insert into public.store_item_images (store_item_id, organization_id, image_url, is_primary, sort_order)
select si.id, si.organization_id, si.image_url, true, 0
from public.store_items si
where nullif(trim(coalesce(si.image_url, '')), '') is not null;

-- ============================================================
-- 3. RPCs de gerenciamento (mesmo padrao de permissao/organizacao de
--    upsert_store_item / upsert_store_item_variant: current_user_has_permission
--    + user_can_access_organization, nunca confiar em id vindo do client sem
--    validar dono).
-- ============================================================

create or replace function public.add_store_item_image(p_store_item_id uuid, p_image_url text) returns uuid
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_id uuid; v_next_sort integer; v_has_primary boolean;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_image_url, '')), '') is null then raise exception 'Imagem obrigatoria.'; end if;

  select exists(select 1 from public.store_item_images where store_item_id = p_store_item_id and is_primary) into v_has_primary;
  select coalesce(max(sort_order) + 1, 0) into v_next_sort from public.store_item_images where store_item_id = p_store_item_id;

  insert into public.store_item_images (store_item_id, organization_id, image_url, is_primary, sort_order)
  values (p_store_item_id, v_item.organization_id, trim(p_image_url), not v_has_primary, v_next_sort)
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.remove_store_item_image(p_image_id uuid) returns void
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_image public.store_item_images%rowtype; v_next_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_image from public.store_item_images where id = p_image_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_image.organization_id) then raise exception 'Imagem invalida ou sem acesso.'; end if;

  delete from public.store_item_images where id = p_image_id;

  -- Se a imagem removida era a principal, promove a proxima da ordem.
  if v_image.is_primary then
    select id into v_next_id from public.store_item_images
      where store_item_id = v_image.store_item_id order by sort_order, created_at limit 1;
    if v_next_id is not null then
      update public.store_item_images set is_primary = true where id = v_next_id;
    end if;
  end if;
end; $$;

create or replace function public.set_store_item_primary_image(p_image_id uuid) returns void
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_image public.store_item_images%rowtype;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_image from public.store_item_images where id = p_image_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_image.organization_id) then raise exception 'Imagem invalida ou sem acesso.'; end if;

  update public.store_item_images set is_primary = false where store_item_id = v_image.store_item_id and is_primary and id <> p_image_id;
  update public.store_item_images set is_primary = true where id = p_image_id;
end; $$;

create or replace function public.reorder_store_item_images(p_store_item_id uuid, p_image_ids uuid[]) returns void
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_id uuid; v_pos integer := 0; v_expected integer;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;

  select count(*) into v_expected from public.store_item_images where store_item_id = p_store_item_id;
  if v_expected <> coalesce(array_length(p_image_ids, 1), 0) then raise exception 'Lista de imagens nao corresponde as imagens cadastradas do item.'; end if;

  foreach v_id in array p_image_ids loop
    update public.store_item_images set sort_order = v_pos where id = v_id and store_item_id = p_store_item_id;
    if not found then raise exception 'Imagem % nao pertence a este item.', v_id; end if;
    v_pos := v_pos + 1;
  end loop;
end; $$;

grant execute on function public.add_store_item_image(uuid, text) to authenticated, service_role;
grant execute on function public.remove_store_item_image(uuid) to authenticated, service_role;
grant execute on function public.set_store_item_primary_image(uuid) to authenticated, service_role;
grant execute on function public.reorder_store_item_images(uuid, uuid[]) to authenticated, service_role;
revoke all on function public.add_store_item_image(uuid, text) from anon;
revoke all on function public.remove_store_item_image(uuid) from anon;
revoke all on function public.set_store_item_primary_image(uuid) from anon;
revoke all on function public.reorder_store_item_images(uuid, uuid[]) from anon;

-- ============================================================
-- 4. Storage: bucket "store-item-images" passa a ser criado de forma
--    reproduzivel (antes so existia fora de migration/dashboard -- sem
--    isso `supabase db reset` local nao tinha o bucket). Path convention
--    passa de "uuid solto" (sem dono) para "{store_item_id}/{arquivo}",
--    igual ao padrao ja usado em sponsor-banners ("{sponsor_id}/..."):
--    o path vira a fronteira de seguranca. A policy antiga so checava a
--    permissao RBAC global (store.manage), entao um staff com essa
--    permissao em QUALQUER organizacao conseguia sobrescrever/apagar
--    imagem de produto de OUTRA organizacao -- a policy nova tambem exige
--    que o store_item dono da pasta pertenca a uma organizacao que o ator
--    pode acessar.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-item-images', 'store-item-images', true, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "store_item_images_manage_delete" on storage.objects;
drop policy if exists "store_item_images_manage_insert" on storage.objects;
drop policy if exists "store_item_images_manage_update" on storage.objects;
drop policy if exists "store_item_images_public_read" on storage.objects;

create policy "store_item_images_public_read"
on storage.objects for select
using (bucket_id = 'store-item-images');

create policy "store_item_images_manage_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'store-item-images'
  and public.current_user_has_permission('store.manage')
  and exists (
    select 1 from public.store_items si
    where si.id::text = (storage.foldername(storage.objects.name))[1]
      and public.user_can_access_organization(auth.uid(), si.organization_id)
  )
);

create policy "store_item_images_manage_update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'store-item-images'
  and public.current_user_has_permission('store.manage')
  and exists (
    select 1 from public.store_items si
    where si.id::text = (storage.foldername(storage.objects.name))[1]
      and public.user_can_access_organization(auth.uid(), si.organization_id)
  )
);

create policy "store_item_images_manage_delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'store-item-images'
  and public.current_user_has_permission('store.manage')
  and exists (
    select 1 from public.store_items si
    where si.id::text = (storage.foldername(storage.objects.name))[1]
      and public.user_can_access_organization(auth.uid(), si.organization_id)
  )
);

-- ============================================================
-- 5. Reescreve consumidores de store_items.image_url para ler da imagem
--    principal em store_item_images, ANTES de remover a coluna antiga.
-- ============================================================

-- 5a. list_store_items_for_event: fonte canonica compartilhada pelo card da
-- loja (get-store-items.ts) e pelo "Compre junto" (cart-step.tsx). Muda o
-- formato de retorno (nova coluna "images"), entao precisa de drop antes do
-- create or replace.
drop function if exists public.list_store_items_for_event(uuid);

create function public.list_store_items_for_event(p_event_id uuid) returns table(
  store_item_id uuid, event_id uuid, name text, slug text, description text,
  image_url text, images jsonb,
  price numeric, requires_variant boolean, supply_mode text, sort_order integer,
  variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
  language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.event_id, si.name, si.slug, si.description,
    (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    (select coalesce(jsonb_agg(jsonb_build_object('id', sii.id, 'url', sii.image_url, 'is_primary', sii.is_primary) order by sii.sort_order, sii.created_at), '[]'::jsonb)
       from public.store_item_images sii where sii.store_item_id = si.id),
    si.price, si.requires_variant, si.supply_mode, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    case when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where (si.event_id = p_event_id or si.event_id is null) and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to anon, authenticated, service_role;

-- 5b. upsert_store_item: imagem sai deste RPC (gerenciada pelas RPCs da
-- secao 3, uma vez que o item ja existe). Assinatura muda (remove
-- p_image_url), entao precisa de drop antes do create.
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer, text, boolean);

create function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer,
  p_supply_mode text default 'stock', p_available_all_events boolean default false
) returns uuid
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;

  if p_id is not null then
    select * into v_existing from public.store_items where id = p_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_existing.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
    v_org := v_existing.organization_id;
  else
    select * into v_event from public.events where id = p_event_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
    v_org := v_event.organization_id;
  end if;

  v_stored_event_id := case when coalesce(p_available_all_events, false) then null else p_event_id end;
  if v_stored_event_id is not null then
    select * into v_event from public.events where id = v_stored_event_id;
    if not found or v_event.organization_id <> v_org then raise exception 'Evento invalido para este item.'; end if;
  end if;

  if p_id is null then
    insert into public.store_items (organization_id, event_id, name, slug, description, price, requires_variant, is_active, sort_order, supply_mode)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean) to authenticated, service_role;
revoke all on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean) from anon;

-- 5c. get_organization_coupon_scope_options: usava si.image_url so como
-- miniatura no seletor de produtos do admin de cupons.
create or replace function public.get_organization_coupon_scope_options(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_events jsonb; v_categories jsonb; v_products jsonb;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  if not public.user_can_access_organization(v_actor, p_organization_id) then raise exception 'Sem acesso a organizacao.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'year',e.year) order by e.starts_at desc nulls last),'[]'::jsonb)
    into v_events from public.events e where e.organization_id = p_organization_id and e.archived_at is null;

  select coalesce(jsonb_agg(jsonb_build_object('id',tc.id,'name',tc.name,'event_id',tc.event_id) order by tc.event_id,tc.sort_order),'[]'::jsonb)
    into v_categories from public.ticket_categories tc join public.events e on e.id=tc.event_id
    where e.organization_id = p_organization_id and tc.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',si.id,'name',si.name,'price',si.price,'is_active',si.is_active,
      'image_url',(select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1)
    ) order by si.sort_order,si.name),'[]'::jsonb)
    into v_products from public.store_items si where si.organization_id = p_organization_id;

  return jsonb_build_object('events',v_events,'ticket_categories',v_categories,'store_items',v_products);
end; $$;

-- 5d. get_cart_order_details: imagem do item ja adicionado ao carrinho.
create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status,
    'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'holder_full_name', oi.holder_full_name,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by oi.item_kind, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'event_id', v_order.event_id, 'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'items', v_items
  );
end; $$;

-- ============================================================
-- 6. Remove a fonte antiga. store_item_images e, a partir daqui, a UNICA
--    fonte de imagem de produto -- nada mais le ou escreve store_items.image_url.
-- ============================================================

alter table public.store_items drop column if exists image_url;

commit;
