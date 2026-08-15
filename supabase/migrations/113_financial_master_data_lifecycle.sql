-- 113_financial_master_data_lifecycle.sql
-- Edicao e exclusao segura de categorias e fornecedores; preserva referencias historicas.
begin;

alter table public.financial_suppliers drop constraint if exists financial_suppliers_organization_id_tax_identifier_key;
create unique index if not exists uq_financial_suppliers_org_tax_identifier
  on public.financial_suppliers(organization_id,tax_identifier) where tax_identifier is not null;

create or replace function public.upsert_financial_supplier(p_organization_id uuid,p_supplier_id uuid,p_legal_name text,p_display_name text,p_tax_identifier text,p_is_active boolean,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_tax text:=nullif(regexp_replace(coalesce(p_tax_identifier,''),'[^0-9]','','g'),'');
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_suppliers') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if nullif(trim(p_legal_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Fornecedor invalido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':supplier:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_supplier_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1;
  if v_id is not null then return v_id; end if;
  if p_supplier_id is null then
    if v_tax is not null then select id into v_id from public.financial_suppliers where organization_id=p_organization_id and tax_identifier=v_tax for update; end if;
    if v_id is null then insert into public.financial_suppliers(organization_id,legal_name,display_name,tax_identifier,is_active) values(p_organization_id,trim(p_legal_name),nullif(trim(p_display_name),''),v_tax,coalesce(p_is_active,true)) returning id into v_id;
    else update public.financial_suppliers set legal_name=trim(p_legal_name),display_name=nullif(trim(p_display_name),''),is_active=coalesce(p_is_active,true),updated_at=now() where id=v_id; end if;
  else
    update public.financial_suppliers set legal_name=trim(p_legal_name),display_name=nullif(trim(p_display_name),''),tax_identifier=v_tax,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_supplier_id and organization_id=p_organization_id returning id into v_id;
    if v_id is null then raise exception 'Fornecedor financeiro nao encontrado.'; end if;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_supplier_upserted','financial_suppliers',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.remove_financial_category(p_organization_id uuid,p_category_id uuid,p_reason text,p_idempotency_key text)
returns text language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_category public.financial_categories%rowtype; v_result text;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_categories') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_category_id is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Categoria, motivo e referencia sao obrigatorios.'; end if;
  if exists(select 1 from public.audit_logs where action='financial_category_removed' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key)) then return 'already_processed'; end if;
  select * into v_category from public.financial_categories where id=p_category_id and organization_id=p_organization_id for update;
  if not found then return 'already_absent'; end if;
  if exists(select 1 from public.financial_entries where category_id=p_category_id and organization_id=p_organization_id) then update public.financial_categories set is_active=false,updated_at=now() where id=p_category_id; v_result:='deactivated';
  else delete from public.financial_categories where id=p_category_id and organization_id=p_organization_id; v_result:='deleted'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_category_removed','financial_categories',p_category_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'result',v_result,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_result;
end $$;

create or replace function public.remove_financial_supplier(p_organization_id uuid,p_supplier_id uuid,p_reason text,p_idempotency_key text)
returns text language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_supplier public.financial_suppliers%rowtype; v_result text;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_suppliers') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_supplier_id is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Fornecedor, motivo e referencia sao obrigatorios.'; end if;
  if exists(select 1 from public.audit_logs where action='financial_supplier_removed' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key)) then return 'already_processed'; end if;
  select * into v_supplier from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id for update;
  if not found then return 'already_absent'; end if;
  if exists(select 1 from public.financial_entries where supplier_id=p_supplier_id and organization_id=p_organization_id) then update public.financial_suppliers set is_active=false,updated_at=now() where id=p_supplier_id; v_result:='deactivated';
  else delete from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id; v_result:='deleted'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_supplier_removed','financial_suppliers',p_supplier_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'result',v_result,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_result;
end $$;

revoke all on function public.remove_financial_category(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.remove_financial_supplier(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.remove_financial_category(uuid,uuid,text,text) to authenticated;
grant execute on function public.remove_financial_supplier(uuid,uuid,text,text) to authenticated;

commit;
