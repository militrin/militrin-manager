-- Evolucao estrutural de cupons: de "1 cupom = 1 evento, desconto sobre o
-- pedido inteiro" para "cupom pertence a organizacao, com escopo
-- configuravel (ingressos e/ou produtos, eventos/categorias/produtos
-- especificos ou todos), calculado item a item".
--
-- Achados que motivam correcoes incluidas aqui (nao sao workarounds, sao
-- bugs reais na fonte canonica de cupons, corrigidos ao reescrever as RPCs):
-- 1) create_coupon/update_coupon/toggle_coupon_active nao tinham NENHUMA
--    checagem de autenticacao/autorizacao e estavam liberadas por GRANT ate
--    para "anon" -- corrigido com current_user_has_permission('coupons.view')
--    (mesmo padrao ja usado para import_current_event_contact_first).
-- 2) redeem_coupon/coupon_redemptions sao codigo orfao (nada no fluxo real
--    de checkout os chama) -- used_count nunca era incrementado em producao.
--    Superado por uma nova tabela de auditoria (order_item_discounts,
--    proxima migration) ligada a order_items, a cadeia canonica real.
--
-- Estrategia de compatibilidade para cupons existentes: cada cupom legado
-- (coupon_type: courtesy=100% ou percentage) e migrado para
-- discount_type='percentage' (cortesia = percentual 100, sem categoria
-- propria no novo modelo -- ver relatorio), applies_to_tickets=true,
-- applies_to_products=false, com uma linha em coupon_event_scopes apontando
-- para o event_id original e NENHUMA linha em coupon_ticket_category_scopes
-- (== "todas as categorias daquele evento", que e exatamente o
-- comportamento observavel de hoje). Nenhum cupom legado ganha escopo de
-- produto automaticamente.
begin;

-- ============================================================
-- 1. coupons: organizacao como dono real; tipo de desconto expandido
-- ============================================================

alter table public.coupons
  add column organization_id uuid references public.organizations(id),
  add column discount_type text,
  add column discount_value numeric,
  add column applies_to_tickets boolean not null default false,
  add column applies_to_products boolean not null default false;

update public.coupons c set
  organization_id = e.organization_id,
  discount_type = 'percentage',
  discount_value = c.discount_percent,
  applies_to_tickets = true,
  applies_to_products = false
from public.events e
where e.id = c.event_id;

alter table public.coupons
  alter column organization_id set not null,
  alter column discount_type set not null,
  alter column discount_value set not null;

alter table public.coupons
  add constraint coupons_discount_type_check check (discount_type in ('percentage','fixed')),
  add constraint coupons_discount_value_check check (
    (discount_type = 'percentage' and discount_value > 0 and discount_value <= 100)
    or (discount_type = 'fixed' and discount_value > 0)
  ),
  add constraint coupons_applies_to_something_check check (applies_to_tickets or applies_to_products);

-- Resolve colisoes de codigo dentro da mesma organizacao (antes o codigo so
-- precisava ser unico POR EVENTO; dois eventos da mesma organizacao podiam
-- ter cupons com o mesmo codigo). Mantem o cupom mais antigo com o codigo
-- original; renomeia os demais de forma deterministica e auditavel -- nunca
-- silenciosa.
do $$
declare v_row record; v_suffix integer; v_new_code text;
begin
  for v_row in
    select c.id, c.organization_id, c.code
    from public.coupons c
    where c.id not in (
      select distinct on (organization_id, code) id
      from public.coupons
      order by organization_id, code, created_at asc, id asc
    )
    order by organization_id, code, created_at asc, id asc
  loop
    v_suffix := 2;
    loop
      v_new_code := v_row.code || '-' || v_suffix;
      exit when not exists(select 1 from public.coupons where organization_id = v_row.organization_id and code = v_new_code);
      v_suffix := v_suffix + 1;
    end loop;
    update public.coupons set code = v_new_code, updated_at = now() where id = v_row.id;
    insert into public.audit_logs(action, entity_type, entity_id, details)
    values('coupon_code_renamed_on_org_migration', 'coupons', v_row.id,
      jsonb_build_object('previous_code', v_row.code, 'new_code', v_new_code,
        'reason', 'colisao de codigo dentro da mesma organizacao apos migrar de escopo por evento para escopo por organizacao'));
  end loop;
end $$;

drop index if exists public.ux_coupons_event_code;
create unique index ux_coupons_org_code on public.coupons(organization_id, code);

-- coupon_type/discount_percent ficam totalmente superados por
-- discount_type/discount_value (ja migrados acima). Manter as duas
-- representacoes vivas seria exatamente o problema de "duas fontes de
-- verdade" que este projeto tem evitado deliberadamente (mesmo principio ja
-- aplicado ao estoque de camiseta/produto) -- removidas apos o backfill.
alter table public.coupons drop constraint if exists coupons_percent_check;
alter table public.coupons drop constraint if exists coupons_type_check;
alter table public.coupons drop column coupon_type;
alter table public.coupons drop column discount_percent;

comment on column public.coupons.organization_id is 'Dono real do cupom. Escopo de aplicacao (quais eventos/categorias/produtos) vive nas tabelas coupon_event_scopes/coupon_ticket_category_scopes/coupon_product_scopes, nunca em coupons.event_id.';
comment on column public.coupons.event_id is 'LEGADO: preservado apenas para nao quebrar FKs/relatorios antigos que ainda apontam para ele. Nao e mais a fonte de escopo -- ver coupon_event_scopes.';
comment on column public.coupons.discount_type is 'percentage (0-100, aplicado sobre o subtotal ELEGIVEL) ou fixed (valor em R$, limitado ao subtotal elegivel -- nunca gera total negativo nem "sobra" para itens nao elegiveis).';
comment on column public.coupons.applies_to_tickets is 'Se true, ingressos podem ser elegiveis (escopo fino em coupon_event_scopes/coupon_ticket_category_scopes).';
comment on column public.coupons.applies_to_products is 'Se true, produtos da loja podem ser elegiveis (escopo fino em coupon_product_scopes).';

alter table public.coupons alter column event_id drop not null;

-- ============================================================
-- 2. Tabelas de escopo (relacionais, com integridade referencial real --
--    nunca array/jsonb de IDs, seguindo o padrao ja usado no schema para
--    relacoes N:N como admin_role_permissions).
-- ============================================================

create table public.coupon_event_scopes (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(coupon_id, event_id)
);
comment on table public.coupon_event_scopes is 'Presenca de QUALQUER linha para um cupom = escopo "eventos especificos". Ausencia total de linhas (com coupons.applies_to_tickets=true) = "todos os eventos da organizacao".';

create table public.coupon_ticket_category_scopes (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  ticket_category_id uuid not null references public.ticket_categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(coupon_id, ticket_category_id)
);
comment on table public.coupon_ticket_category_scopes is 'Restricao OPCIONAL e mais fina, dentro dos eventos ja selecionados em coupon_event_scopes. Ausencia de linhas para um evento ja escopado = "todas as categorias daquele evento".';

create table public.coupon_product_scopes (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  store_item_id uuid not null references public.store_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(coupon_id, store_item_id)
);
comment on table public.coupon_product_scopes is 'Presenca de QUALQUER linha para um cupom = escopo "produtos especificos". Ausencia total de linhas (com coupons.applies_to_products=true) = "todos os produtos da organizacao".';

create index idx_coupon_event_scopes_coupon on public.coupon_event_scopes(coupon_id);
create index idx_coupon_event_scopes_event on public.coupon_event_scopes(event_id);
create index idx_coupon_ticket_category_scopes_coupon on public.coupon_ticket_category_scopes(coupon_id);
create index idx_coupon_ticket_category_scopes_category on public.coupon_ticket_category_scopes(ticket_category_id);
create index idx_coupon_product_scopes_coupon on public.coupon_product_scopes(coupon_id);
create index idx_coupon_product_scopes_product on public.coupon_product_scopes(store_item_id);

-- Backfill: cada cupom legado ganha exatamente 1 linha apontando pro seu
-- event_id original -- preserva 100% o comportamento observavel de hoje
-- (cupom so valia naquele evento, todas as categorias).
insert into public.coupon_event_scopes(coupon_id, event_id)
select c.id, c.event_id from public.coupons c where c.event_id is not null
on conflict do nothing;

-- ============================================================
-- 3. Isolamento multi-tenant real, garantido por trigger (nao so pela app):
--    um cupom de uma organizacao jamais pode referenciar evento/categoria/
--    produto de outra organizacao.
-- ============================================================

create or replace function public.enforce_coupon_event_scope_tenant() returns trigger
    language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_coupon_org uuid; v_event_org uuid;
begin
  select organization_id into v_coupon_org from public.coupons where id = new.coupon_id;
  select organization_id into v_event_org from public.events where id = new.event_id;
  if v_coupon_org is null or v_event_org is null or v_coupon_org <> v_event_org then
    raise exception 'Evento nao pertence a organizacao do cupom.';
  end if;
  return new;
end; $$;
create trigger trg_coupon_event_scope_tenant before insert or update on public.coupon_event_scopes
  for each row execute function public.enforce_coupon_event_scope_tenant();

create or replace function public.enforce_coupon_category_scope_tenant() returns trigger
    language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_category_event_id uuid;
begin
  select event_id into v_category_event_id from public.ticket_categories where id = new.ticket_category_id;
  if v_category_event_id is null then raise exception 'Categoria invalida.'; end if;
  if not exists(select 1 from public.coupon_event_scopes s where s.coupon_id = new.coupon_id and s.event_id = v_category_event_id) then
    raise exception 'Categoria so pode ser escopada depois que o evento correspondente ja estiver selecionado no cupom.';
  end if;
  return new;
end; $$;
create trigger trg_coupon_category_scope_tenant before insert or update on public.coupon_ticket_category_scopes
  for each row execute function public.enforce_coupon_category_scope_tenant();

create or replace function public.enforce_coupon_product_scope_tenant() returns trigger
    language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_coupon_org uuid; v_product_org uuid;
begin
  select organization_id into v_coupon_org from public.coupons where id = new.coupon_id;
  select organization_id into v_product_org from public.store_items where id = new.store_item_id;
  if v_coupon_org is null or v_product_org is null or v_coupon_org <> v_product_org then
    raise exception 'Produto nao pertence a organizacao do cupom.';
  end if;
  return new;
end; $$;
create trigger trg_coupon_product_scope_tenant before insert or update on public.coupon_product_scopes
  for each row execute function public.enforce_coupon_product_scope_tenant();

-- RLS: leitura restrita por organizacao (hoje coupons_read_only usava
-- USING(true), ou seja, qualquer cupom de qualquer organizacao era legivel
-- por qualquer autenticado -- corrigido aqui tambem, ja que estamos
-- reescrevendo o modelo).
drop policy if exists coupons_read_only on public.coupons;
create policy coupons_org_select on public.coupons for select
  using (public.is_platform_owner(auth.uid()) or public.user_can_access_organization(auth.uid(), organization_id));

alter table public.coupon_event_scopes enable row level security;
alter table public.coupon_ticket_category_scopes enable row level security;
alter table public.coupon_product_scopes enable row level security;

create policy coupon_event_scopes_select on public.coupon_event_scopes for select
  using (exists(select 1 from public.coupons c where c.id = coupon_id and (public.is_platform_owner(auth.uid()) or public.user_can_access_organization(auth.uid(), c.organization_id))));
create policy coupon_ticket_category_scopes_select on public.coupon_ticket_category_scopes for select
  using (exists(select 1 from public.coupons c where c.id = coupon_id and (public.is_platform_owner(auth.uid()) or public.user_can_access_organization(auth.uid(), c.organization_id))));
create policy coupon_product_scopes_select on public.coupon_product_scopes for select
  using (exists(select 1 from public.coupons c where c.id = coupon_id and (public.is_platform_owner(auth.uid()) or public.user_can_access_organization(auth.uid(), c.organization_id))));

commit;
