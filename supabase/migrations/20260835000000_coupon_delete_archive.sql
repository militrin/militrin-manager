-- Exclusao/arquivamento de cupons.
--
-- Ate aqui um cupom so podia ser ativado/desativado (is_active) -- nunca
-- excluido. Isso e um problema de higiene de cadastro (cupons de teste ou
-- criados errado ficam para sempre na lista) mas excluir um cupom que ja foi
-- usado de verdade quebraria o historico: order_item_discounts.coupon_id e
-- orders.applied_coupon_id e coupon_redemptions.coupon_id apontam pra
-- coupons.id SEM "on delete cascade" (de proposito -- ver
-- 20260827000000_cart_coupon_engine.sql e 20260815001914_remote_schema.sql),
-- entao um DELETE direto ja falharia com violacao de FK nesses casos -- mas
-- com uma mensagem generica de banco, sem dar ao admin nenhuma alternativa.
--
-- Regra implementada: exclusao definitiva SO quando o cupom nunca foi usado
-- (nenhuma linha em order_item_discounts/orders.applied_coupon_id/
-- coupon_redemptions referenciando ele, nem used_count > 0 como cinto de
-- seguranca extra). Quando ja foi usado, arquiva em vez de excluir --
-- archived_at/archived_by, mesmo padrao ja usado em events (ver
-- archive_event/restore_event), forcando is_active=false (assim os checks de
-- is_active que ja existem em apply_cart_coupon/validate_coupon passam a
-- barrar o cupom arquivado automaticamente, sem precisar duplicar logica de
-- validacao la). Nenhuma linha de order_item_discounts, orders ou audit_logs
-- e alterada em nenhum dos dois casos -- so a linha do proprio cupom.
begin;

alter table public.coupons
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id);

create index if not exists idx_coupons_archived_at on public.coupons (archived_at);

-- ============================================================
-- Cupom arquivado passa a ser um estado terminal: nao pode ser editado nem
-- reativado/desativado por fora do fluxo de exclusao/arquivamento (evita o
-- estado inconsistente de archived_at preenchido com is_active=true).
-- ============================================================

create or replace function public.update_organization_coupon(
  p_coupon_id uuid, p_code text, p_discount_type text, p_discount_value numeric,
  p_applies_to_tickets boolean, p_applies_to_products boolean,
  p_max_uses integer default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null,
  p_notes text default null, p_is_active boolean default true,
  p_event_ids uuid[] default array[]::uuid[], p_ticket_category_ids uuid[] default array[]::uuid[],
  p_store_item_ids uuid[] default array[]::uuid[]
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_coupon public.coupons%rowtype; v_code text := upper(trim(coalesce(p_code,'')));
  v_type text := lower(trim(coalesce(p_discount_type,''))); v_value numeric := coalesce(p_discount_value,0); v_bad_count integer;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  select * into v_coupon from public.coupons where id = p_coupon_id for update;
  if not found then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_coupon.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_coupon.archived_at is not null then raise exception 'Cupom arquivado nao pode ser editado.'; end if;
  if v_code = '' then raise exception 'Codigo do cupom obrigatorio.'; end if;
  if v_type not in ('percentage','fixed') then raise exception 'Tipo de desconto invalido.'; end if;
  if v_type = 'percentage' and (v_value <= 0 or v_value > 100) then raise exception 'Percentual deve ser maior que 0 e menor ou igual a 100.'; end if;
  if v_type = 'fixed' and v_value <= 0 then raise exception 'Valor fixo deve ser maior que zero.'; end if;
  if not coalesce(p_applies_to_tickets,false) and not coalesce(p_applies_to_products,false) then raise exception 'Selecione ao menos um escopo: ingressos e/ou produtos.'; end if;
  if p_max_uses is not null and p_max_uses <= 0 then raise exception 'Limite de usos deve ser maior que zero.'; end if;
  if p_max_uses is not null and p_max_uses < v_coupon.used_count then raise exception 'Limite de usos nao pode ser menor que o ja utilizado (%).', v_coupon.used_count; end if;

  if array_length(p_event_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_event_ids) eid where not exists(select 1 from public.events e where e.id=eid and e.organization_id=v_coupon.organization_id);
    if v_bad_count > 0 then raise exception 'Um ou mais eventos selecionados nao pertencem a esta organizacao.'; end if;
  end if;
  if array_length(p_ticket_category_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_ticket_category_ids) tcid
      where not exists(select 1 from public.ticket_categories tc join public.events e on e.id=tc.event_id where tc.id=tcid and e.organization_id=v_coupon.organization_id and e.id=any(p_event_ids));
    if v_bad_count > 0 then raise exception 'Uma ou mais categorias selecionadas nao pertencem aos eventos escolhidos desta organizacao.'; end if;
  end if;
  if array_length(p_store_item_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_store_item_ids) sid where not exists(select 1 from public.store_items si where si.id=sid and si.organization_id=v_coupon.organization_id);
    if v_bad_count > 0 then raise exception 'Um ou mais produtos selecionados nao pertencem a esta organizacao.'; end if;
  end if;

  update public.coupons set code=v_code,discount_type=v_type,discount_value=v_value,
    applies_to_tickets=coalesce(p_applies_to_tickets,false),applies_to_products=coalesce(p_applies_to_products,false),
    max_uses=p_max_uses,valid_from=p_valid_from,valid_until=p_valid_until,notes=nullif(trim(coalesce(p_notes,'')),''),
    is_active=coalesce(p_is_active,true),updated_at=now()
  where id = p_coupon_id;

  delete from public.coupon_event_scopes where coupon_id = p_coupon_id;
  delete from public.coupon_ticket_category_scopes where coupon_id = p_coupon_id;
  delete from public.coupon_product_scopes where coupon_id = p_coupon_id;
  if array_length(p_event_ids,1) > 0 then
    insert into public.coupon_event_scopes(coupon_id,event_id) select p_coupon_id, eid from unnest(p_event_ids) eid;
  end if;
  if array_length(p_ticket_category_ids,1) > 0 then
    insert into public.coupon_ticket_category_scopes(coupon_id,ticket_category_id) select p_coupon_id, tcid from unnest(p_ticket_category_ids) tcid;
  end if;
  if array_length(p_store_item_ids,1) > 0 then
    insert into public.coupon_product_scopes(coupon_id,store_item_id) select p_coupon_id, sid from unnest(p_store_item_ids) sid;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,details)
  values('coupon_updated','coupons',p_coupon_id,jsonb_build_object('actor_user_id',v_actor,'code',v_code,
    'discount_type',v_type,'discount_value',v_value,'applies_to_tickets',p_applies_to_tickets,'applies_to_products',p_applies_to_products,
    'event_ids',p_event_ids,'ticket_category_ids',p_ticket_category_ids,'store_item_ids',p_store_item_ids));

  return p_coupon_id;
end; $$;

create or replace function public.set_coupon_active(p_coupon_id uuid, p_is_active boolean)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_coupon public.coupons%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  select * into v_coupon from public.coupons where id = p_coupon_id;
  if not found then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_coupon.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_coupon.archived_at is not null then raise exception 'Cupom arquivado nao pode ser ativado ou desativado.'; end if;
  update public.coupons set is_active = coalesce(p_is_active,true), updated_at = now() where id = p_coupon_id;
  insert into public.audit_logs(action,entity_type,entity_id,details)
  values(case when p_is_active then 'coupon_activated' else 'coupon_deactivated' end,'coupons',p_coupon_id,jsonb_build_object('actor_user_id',v_actor));
  return true;
end; $$;

-- ============================================================
-- Listagem com filtro de status (ativos / inativos / arquivados) + sinal de
-- "ja foi usado" por cupom, pra UI decidir de antemao qual confirmacao
-- mostrar antes de excluir (sem round-trip extra no momento do clique).
-- ============================================================

create or replace function public.list_organization_coupons(p_organization_id uuid, p_status text default 'active')
returns table(
  id uuid, code text, discount_type text, discount_value numeric,
  applies_to_tickets boolean, applies_to_products boolean,
  max_uses integer, used_count integer, valid_from timestamptz, valid_until timestamptz,
  is_active boolean, notes text, created_at timestamptz, archived_at timestamptz, has_usage boolean
) language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_status text := lower(trim(coalesce(p_status,'active')));
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  if not public.user_can_access_organization(v_actor, p_organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_status not in ('active','inactive','archived') then raise exception 'Filtro de status invalido: %.', p_status; end if;

  return query
  select c.id, c.code, c.discount_type, c.discount_value, c.applies_to_tickets, c.applies_to_products,
    c.max_uses, c.used_count, c.valid_from, c.valid_until, c.is_active, c.notes, c.created_at, c.archived_at,
    (c.used_count > 0
      or exists(select 1 from public.order_item_discounts oid where oid.coupon_id = c.id)
      or exists(select 1 from public.orders o where o.applied_coupon_id = c.id)
      or exists(select 1 from public.coupon_redemptions cr where cr.coupon_id = c.id))
  from public.coupons c
  where c.organization_id = p_organization_id
    and case v_status
      when 'archived' then c.archived_at is not null
      when 'inactive' then c.archived_at is null and c.is_active = false
      else c.archived_at is null and c.is_active = true
    end
  order by c.created_at desc;
end; $$;

-- ============================================================
-- Exclusao/arquivamento. Decide sozinho qual dos dois faz sentido pro cupom
-- (o client so mostra o texto certo de confirmacao antes de chamar, usando o
-- has_usage devolvido por list_organization_coupons -- mas o servidor
-- SEMPRE reconfere no momento da chamada, entao uma corrida entre o load da
-- lista e o clique nunca resulta em exclusao indevida de cupom ja usado).
-- ============================================================

create or replace function public.delete_or_archive_coupon(p_coupon_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_coupon public.coupons%rowtype; v_has_usage boolean;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  select * into v_coupon from public.coupons where id = p_coupon_id for update;
  if not found then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_coupon.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_coupon.archived_at is not null then raise exception 'Cupom ja esta arquivado.'; end if;

  select (v_coupon.used_count > 0
      or exists(select 1 from public.order_item_discounts oid where oid.coupon_id = p_coupon_id)
      or exists(select 1 from public.orders o where o.applied_coupon_id = p_coupon_id)
      or exists(select 1 from public.coupon_redemptions cr where cr.coupon_id = p_coupon_id))
    into v_has_usage;

  if v_has_usage then
    update public.coupons set is_active = false, archived_at = now(), archived_by = v_actor, updated_at = now() where id = p_coupon_id;
    insert into public.audit_logs(action,entity_type,entity_id,details)
      values('coupon_archived','coupons',p_coupon_id,jsonb_build_object('actor_user_id',v_actor,'code',v_coupon.code,'reason','has_usage'));
    return jsonb_build_object('action','archived','coupon_id',p_coupon_id);
  else
    delete from public.coupon_event_scopes where coupon_id = p_coupon_id;
    delete from public.coupon_ticket_category_scopes where coupon_id = p_coupon_id;
    delete from public.coupon_product_scopes where coupon_id = p_coupon_id;
    delete from public.coupons where id = p_coupon_id;
    insert into public.audit_logs(action,entity_type,entity_id,details)
      values('coupon_deleted','coupons',p_coupon_id,jsonb_build_object('actor_user_id',v_actor,'code',v_coupon.code));
    return jsonb_build_object('action','deleted','coupon_id',p_coupon_id);
  end if;
end; $$;

revoke all on function public.list_organization_coupons(uuid,text) from public,anon;
revoke all on function public.delete_or_archive_coupon(uuid) from public,anon;
grant execute on function public.list_organization_coupons(uuid,text) to authenticated, service_role;
grant execute on function public.delete_or_archive_coupon(uuid) to authenticated, service_role;

commit;
