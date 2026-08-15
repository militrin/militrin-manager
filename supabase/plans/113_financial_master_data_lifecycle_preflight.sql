-- 113_financial_master_data_lifecycle_preflight.sql
-- Estritamente somente leitura: valida edicao, exclusao/desativacao e referencias historicas.
with structure as (
  select to_regclass('public.financial_categories') is not null has_categories,
    to_regclass('public.financial_suppliers') is not null has_suppliers,
    to_regclass('public.financial_entries') is not null has_entries,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard
), signatures as (
  select to_regprocedure('public.remove_financial_category(uuid,uuid,text,text)') is not null has_remove_category,
    to_regprocedure('public.remove_financial_supplier(uuid,uuid,text,text)') is not null has_remove_supplier
), definitions as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.upsert_financial_category(uuid,uuid,text,text,boolean,text)')),'') category_upsert_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text)')),'') supplier_upsert_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.remove_financial_category(uuid,uuid,text,text)')),'') category_remove_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.remove_financial_supplier(uuid,uuid,text,text)')),'') supplier_remove_body
), contract as (
  select position('p_category_id' in category_upsert_body)>0 and position('p_supplier_id' in supplier_upsert_body)>0 supports_edit,
    position('security definer' in lower(category_remove_body))>0 and position('security definer' in lower(supplier_remove_body))>0 protected_remove,
    position('auth.uid()' in lower(category_remove_body||supplier_remove_body))>0 uses_session_actor,
    position('user_can_access_organization' in lower(category_remove_body||supplier_remove_body))>0 validates_organization,
    position('finance.manage_categories' in lower(category_remove_body))>0 category_rbac,
    position('finance.manage_suppliers' in lower(supplier_remove_body))>0 supplier_rbac,
    position('is_active=false' in regexp_replace(lower(category_remove_body||supplier_remove_body),'\s+','','g'))>0 preserves_referenced_history,
    position('financial_category_removed' in lower(category_remove_body))>0 and position('financial_supplier_removed' in lower(supplier_remove_body))>0 records_audit,
    position('service_role' in lower(category_remove_body||supplier_remove_body))=0 avoids_service_role
  from definitions
), supplier_uniqueness as (
  select exists(select 1 from pg_indexes where schemaname='public' and tablename='financial_suppliers' and indexname='uq_financial_suppliers_org_tax_identifier' and indexdef ilike '%where (tax_identifier is not null)%') partial_tax_identifier_unique_installed
), grants as (
  select count(*) filter(where grantee in('anon','PUBLIC') and privilege_type='EXECUTE')::integer anonymous_remove_grant_count
  from information_schema.routine_privileges where routine_schema='public' and routine_name in('remove_financial_category','remove_financial_supplier')
), ambiguities as (
  select (select count(*)::integer from (select organization_id,name from public.financial_categories group by organization_id,name having count(*)>1)x) duplicate_category_name_count,
    (select count(*)::integer from (select organization_id,tax_identifier from public.financial_suppliers where tax_identifier is not null group by organization_id,tax_identifier having count(*)>1)x) duplicate_supplier_tax_identifier_count
)
select s.*,sg.*,c.*,su.*,g.*,a.*,
  not sg.has_remove_category and not sg.has_remove_supplier clean_previous_state,
  sg.has_remove_category and sg.has_remove_supplier and c.supports_edit and c.protected_remove and c.uses_session_actor
    and c.validates_organization and c.category_rbac and c.supplier_rbac and c.preserves_referenced_history
    and c.records_audit and c.avoids_service_role and su.partial_tax_identifier_unique_installed
    and g.anonymous_remove_grant_count=0 idempotent_installed_state,
  s.has_categories and s.has_suppliers and s.has_entries and s.has_permission_resolver and s.has_organization_guard
    and a.duplicate_category_name_count=0 and a.duplicate_supplier_tax_identifier_count=0
    and ((not sg.has_remove_category and not sg.has_remove_supplier)
      or (sg.has_remove_category and sg.has_remove_supplier and c.supports_edit and c.protected_remove and c.uses_session_actor
        and c.validates_organization and c.category_rbac and c.supplier_rbac and c.preserves_referenced_history
        and c.records_audit and c.avoids_service_role and su.partial_tax_identifier_unique_installed
        and g.anonymous_remove_grant_count=0)) safe_to_apply,
  true read_only_preflight
from structure s cross join signatures sg cross join definitions d cross join contract c cross join supplier_uniqueness su cross join grants g cross join ambiguities a;
