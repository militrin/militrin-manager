-- CRUD administrativo seguro para o novo modelo de cupom (organizacao +
-- escopo configuravel). Corrige o achado de seguranca da auditoria: as RPCs
-- antigas (create_coupon/update_coupon/toggle_coupon_active) nao verificavam
-- absolutamente nada e estavam liberadas ate para "anon". As novas exigem
-- current_user_has_permission('coupons.view') (mesmo codigo de permissao ja
-- usado para a pagina /cupons, mesmo padrao ja usado em
-- import_current_event_contact_first) + user_can_access_organization, e
-- validam explicitamente que TODO evento/categoria/produto referenciado
-- pertence a mesma organizacao do cupom antes mesmo de tentar o insert (a
-- trigger da migration anterior e a ultima linha de defesa, nao a unica).
begin;

create or replace function public.create_organization_coupon(
  p_organization_id uuid, p_code text, p_discount_type text, p_discount_value numeric,
  p_applies_to_tickets boolean, p_applies_to_products boolean,
  p_max_uses integer default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null,
  p_notes text default null, p_is_active boolean default true,
  p_event_ids uuid[] default array[]::uuid[], p_ticket_category_ids uuid[] default array[]::uuid[],
  p_store_item_ids uuid[] default array[]::uuid[]
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_coupon_id uuid; v_code text := upper(trim(coalesce(p_code,'')));
  v_type text := lower(trim(coalesce(p_discount_type,''))); v_value numeric := coalesce(p_discount_value,0);
  v_bad_count integer;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  if not public.user_can_access_organization(v_actor, p_organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_code = '' then raise exception 'Codigo do cupom obrigatorio.'; end if;
  if v_type not in ('percentage','fixed') then raise exception 'Tipo de desconto invalido.'; end if;
  if v_type = 'percentage' and (v_value <= 0 or v_value > 100) then raise exception 'Percentual deve ser maior que 0 e menor ou igual a 100.'; end if;
  if v_type = 'fixed' and v_value <= 0 then raise exception 'Valor fixo deve ser maior que zero.'; end if;
  if not coalesce(p_applies_to_tickets,false) and not coalesce(p_applies_to_products,false) then raise exception 'Selecione ao menos um escopo: ingressos e/ou produtos.'; end if;
  if p_max_uses is not null and p_max_uses <= 0 then raise exception 'Limite de usos deve ser maior que zero.'; end if;

  if array_length(p_event_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_event_ids) eid where not exists(select 1 from public.events e where e.id=eid and e.organization_id=p_organization_id);
    if v_bad_count > 0 then raise exception 'Um ou mais eventos selecionados nao pertencem a esta organizacao.'; end if;
  end if;
  if array_length(p_ticket_category_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_ticket_category_ids) tcid
      where not exists(select 1 from public.ticket_categories tc join public.events e on e.id=tc.event_id where tc.id=tcid and e.organization_id=p_organization_id and e.id=any(p_event_ids));
    if v_bad_count > 0 then raise exception 'Uma ou mais categorias selecionadas nao pertencem aos eventos escolhidos desta organizacao.'; end if;
  end if;
  if array_length(p_store_item_ids,1) > 0 then
    select count(*) into v_bad_count from unnest(p_store_item_ids) sid where not exists(select 1 from public.store_items si where si.id=sid and si.organization_id=p_organization_id);
    if v_bad_count > 0 then raise exception 'Um ou mais produtos selecionados nao pertencem a esta organizacao.'; end if;
  end if;

  insert into public.coupons(organization_id,code,discount_type,discount_value,applies_to_tickets,applies_to_products,
    max_uses,valid_from,valid_until,notes,is_active)
  values(p_organization_id,v_code,v_type,v_value,coalesce(p_applies_to_tickets,false),coalesce(p_applies_to_products,false),
    p_max_uses,p_valid_from,p_valid_until,nullif(trim(coalesce(p_notes,'')),''),coalesce(p_is_active,true))
  returning id into v_coupon_id;

  if array_length(p_event_ids,1) > 0 then
    insert into public.coupon_event_scopes(coupon_id,event_id) select v_coupon_id, eid from unnest(p_event_ids) eid;
  end if;
  if array_length(p_ticket_category_ids,1) > 0 then
    insert into public.coupon_ticket_category_scopes(coupon_id,ticket_category_id) select v_coupon_id, tcid from unnest(p_ticket_category_ids) tcid;
  end if;
  if array_length(p_store_item_ids,1) > 0 then
    insert into public.coupon_product_scopes(coupon_id,store_item_id) select v_coupon_id, sid from unnest(p_store_item_ids) sid;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,details)
  values('coupon_created','coupons',v_coupon_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'code',v_code,
    'discount_type',v_type,'discount_value',v_value,'applies_to_tickets',p_applies_to_tickets,'applies_to_products',p_applies_to_products,
    'event_ids',p_event_ids,'ticket_category_ids',p_ticket_category_ids,'store_item_ids',p_store_item_ids));

  return v_coupon_id;
end; $$;

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
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  select organization_id into v_org from public.coupons where id = p_coupon_id;
  if v_org is null then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_org) then raise exception 'Sem acesso a organizacao.'; end if;
  update public.coupons set is_active = coalesce(p_is_active,true), updated_at = now() where id = p_coupon_id;
  insert into public.audit_logs(action,entity_type,entity_id,details)
  values(case when p_is_active then 'coupon_activated' else 'coupon_deactivated' end,'coupons',p_coupon_id,jsonb_build_object('actor_user_id',v_actor));
  return true;
end; $$;

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

  select coalesce(jsonb_agg(jsonb_build_object('id',si.id,'name',si.name,'price',si.price,'image_url',si.image_url,'is_active',si.is_active) order by si.sort_order,si.name),'[]'::jsonb)
    into v_products from public.store_items si where si.organization_id = p_organization_id;

  return jsonb_build_object('events',v_events,'ticket_categories',v_categories,'store_items',v_products);
end; $$;

create or replace function public.get_organization_coupon_details(p_coupon_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_coupon public.coupons%rowtype; v_event_ids jsonb; v_category_ids jsonb; v_product_ids jsonb;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then raise exception 'Sem permissao para gerenciar cupons.'; end if;
  select * into v_coupon from public.coupons where id = p_coupon_id;
  if not found then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_coupon.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;

  select coalesce(jsonb_agg(event_id),'[]'::jsonb) into v_event_ids from public.coupon_event_scopes where coupon_id = p_coupon_id;
  select coalesce(jsonb_agg(ticket_category_id),'[]'::jsonb) into v_category_ids from public.coupon_ticket_category_scopes where coupon_id = p_coupon_id;
  select coalesce(jsonb_agg(store_item_id),'[]'::jsonb) into v_product_ids from public.coupon_product_scopes where coupon_id = p_coupon_id;

  return jsonb_build_object('id',v_coupon.id,'organization_id',v_coupon.organization_id,'code',v_coupon.code,
    'discount_type',v_coupon.discount_type,'discount_value',v_coupon.discount_value,
    'applies_to_tickets',v_coupon.applies_to_tickets,'applies_to_products',v_coupon.applies_to_products,
    'max_uses',v_coupon.max_uses,'used_count',v_coupon.used_count,'valid_from',v_coupon.valid_from,'valid_until',v_coupon.valid_until,
    'is_active',v_coupon.is_active,'notes',v_coupon.notes,
    'event_ids',v_event_ids,'ticket_category_ids',v_category_ids,'store_item_ids',v_product_ids);
end; $$;

revoke all on function public.create_organization_coupon(uuid,text,text,numeric,boolean,boolean,integer,timestamptz,timestamptz,text,boolean,uuid[],uuid[],uuid[]) from public,anon;
revoke all on function public.update_organization_coupon(uuid,text,text,numeric,boolean,boolean,integer,timestamptz,timestamptz,text,boolean,uuid[],uuid[],uuid[]) from public,anon;
revoke all on function public.set_coupon_active(uuid,boolean) from public,anon;
revoke all on function public.get_organization_coupon_scope_options(uuid) from public,anon;
revoke all on function public.get_organization_coupon_details(uuid) from public,anon;
grant execute on function public.create_organization_coupon(uuid,text,text,numeric,boolean,boolean,integer,timestamptz,timestamptz,text,boolean,uuid[],uuid[],uuid[]) to authenticated,service_role;
grant execute on function public.update_organization_coupon(uuid,text,text,numeric,boolean,boolean,integer,timestamptz,timestamptz,text,boolean,uuid[],uuid[],uuid[]) to authenticated,service_role;
grant execute on function public.set_coupon_active(uuid,boolean) to authenticated,service_role;
grant execute on function public.get_organization_coupon_scope_options(uuid) to authenticated,service_role;
grant execute on function public.get_organization_coupon_details(uuid) to authenticated,service_role;

-- Deprecacao explicita das RPCs legadas (assinatura incompativel com o novo
-- schema de coupons; corrigido tambem o achado de seguranca: nao tinham
-- NENHUMA checagem de autorizacao e estavam liberadas para "anon").
create or replace function public.create_coupon(p_event_id uuid,p_code text,p_coupon_type text,p_discount_percent numeric,
  p_max_uses integer,p_valid_from timestamptz,p_valid_until timestamptz,p_notes text,p_is_active boolean)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin raise exception 'RPC legada desativada: use create_organization_coupon.' using errcode='P0001'; end; $$;

create or replace function public.update_coupon(p_coupon_id uuid,p_event_id uuid,p_code text,p_coupon_type text,p_discount_percent numeric,
  p_max_uses integer,p_valid_from timestamptz,p_valid_until timestamptz,p_notes text,p_is_active boolean)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin raise exception 'RPC legada desativada: use update_organization_coupon.' using errcode='P0001'; end; $$;

create or replace function public.toggle_coupon_active(p_coupon_id uuid,p_event_id uuid,p_is_active boolean)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin raise exception 'RPC legada desativada: use set_coupon_active.' using errcode='P0001'; end; $$;

revoke all on function public.create_coupon(uuid,text,text,numeric,integer,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
revoke all on function public.update_coupon(uuid,uuid,text,text,numeric,integer,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
revoke all on function public.toggle_coupon_active(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.create_coupon(uuid,text,text,numeric,integer,timestamptz,timestamptz,text,boolean) to service_role;
grant execute on function public.update_coupon(uuid,uuid,text,text,numeric,integer,timestamptz,timestamptz,text,boolean) to service_role;
grant execute on function public.toggle_coupon_active(uuid,uuid,boolean) to service_role;

commit;
