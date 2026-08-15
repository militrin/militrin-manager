-- 110_financial_ledger_foundation_preflight.sql
-- Estritamente somente leitura: valida pré-requisitos e o estado idempotente da migration 110.
with permission_plan(code,name,description,module,sort_order,is_active) as (values
  ('finance.manage_accounts','Gerenciar contas financeiras','Cria e altera o plano de contas financeiro','finance',70,true),
  ('finance.manage_categories','Gerenciar categorias financeiras','Cria e altera categorias de receitas e despesas','finance',80,true),
  ('finance.manage_suppliers','Gerenciar fornecedores','Cria e altera fornecedores financeiros','finance',90,true),
  ('finance.manage_entries','Gerenciar lancamentos','Cria receitas, despesas, transferencias e ajustes','finance',100,true),
  ('finance.manage_expenses','Gerenciar despesas','Autoriza a criacao de despesas','finance',110,true),
  ('finance.manage_income','Gerenciar receitas','Autoriza a criacao de receitas','finance',120,true),
  ('finance.reconcile','Conciliar financeiro','Registra conciliacoes financeiras','finance',130,true),
  ('finance.approve_refund','Aprovar estornos','Aprova estornos financeiros sem ampliar a permissao legada','finance',140,true)
), structure as (
  select
    to_regclass('public.organizations') is not null has_organizations,
    to_regclass('public.events') is not null has_events,
    to_regclass('public.payments') is not null has_payments,
    to_regclass('public.audit_logs') is not null has_audit_logs,
    to_regclass('public.admin_permissions') is not null has_admin_permissions,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard
), existing_contract as (
  select
    count(*) filter(where table_name='payments' and column_name in('id','organization_id','event_id','payment_status','amount','final_amount'))=6 payments_contract_ok,
    count(*) filter(where table_name='audit_logs' and column_name in('id','action','entity_type','entity_id','event_id','details','created_at'))=7 audit_contract_ok,
    count(*) filter(where table_name='events' and column_name in('id','organization_id'))=2 events_contract_ok
  from information_schema.columns
  where table_schema='public' and table_name in('payments','audit_logs','events')
), permissions as (
  select
    exists(select 1 from public.admin_permissions where code='finance.view' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_finance_view,
    exists(select 1 from public.admin_permissions where code='finance.view_amounts' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_finance_view_amounts,
    exists(select 1 from public.admin_permissions where code='finance.confirm_payment' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_finance_confirm,
    exists(select 1 from public.admin_permissions where code='finance.refund' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_finance_refund
), permission_catalog_structure as (
  select
    count(*) filter(where column_name in('id','code','name','description','module','sort_order','is_active'))=7 admin_permissions_structure_ok,
    exists(select 1 from pg_indexes where schemaname='public' and tablename='admin_permissions' and indexdef ilike '%unique%' and indexdef ilike '%code%') admin_permissions_code_is_unique
  from information_schema.columns where table_schema='public' and table_name='admin_permissions'
), planned_permissions as (
  select
    (select count(*)::integer from permission_plan) planned_permission_count,
    count(ap.id)::integer installed_planned_permission_count,
    count(ap.id) filter(where ap.name<>p.name or ap.description is distinct from p.description or ap.module<>p.module
      or ap.sort_order<>p.sort_order or ap.is_active<>p.is_active)::integer incompatible_planned_permission_count
  from permission_plan p left join public.admin_permissions ap using(code)
), legacy_integrity as (
  select
    count(*) filter(where organization_id is null)::integer payments_without_organization_count,
    count(*) filter(where event_id is not null and not exists(select 1 from public.events e where e.id=payments.event_id and e.organization_id=payments.organization_id))::integer payment_event_organization_mismatch_count
  from public.payments
), ledger_tables as (
  select
    to_regclass('public.financial_accounts') is not null has_financial_accounts,
    to_regclass('public.financial_categories') is not null has_financial_categories,
    to_regclass('public.financial_suppliers') is not null has_financial_suppliers,
    to_regclass('public.financial_entries') is not null has_financial_entries,
    to_regclass('public.financial_entry_lines') is not null has_financial_entry_lines,
    to_regclass('public.financial_event_allocations') is not null has_financial_event_allocations,
    to_regclass('public.financial_reconciliations') is not null has_financial_reconciliations,
    to_regclass('public.financial_reversals') is not null has_financial_reversals
), installed_columns as (
  select
    count(*) filter(where table_name='financial_accounts' and column_name in('id','organization_id','code','name','account_type','is_active'))=6 accounts_structure_ok,
    count(*) filter(where table_name='financial_categories' and column_name in('id','organization_id','name','entry_kind','is_active'))=5 categories_structure_ok,
    count(*) filter(where table_name='financial_suppliers' and column_name in('id','organization_id','legal_name','tax_identifier','is_active'))=5 suppliers_structure_ok,
    count(*) filter(where table_name='financial_entries' and column_name in('id','organization_id','entry_kind','lifecycle_status','amount','due_date','source_payment_id','idempotency_key','created_by'))=9 entries_structure_ok,
    count(*) filter(where table_name='financial_entry_lines' and column_name in('id','entry_id','organization_id','account_id','line_side','amount'))=6 lines_structure_ok,
    count(*) filter(where table_name='financial_event_allocations' and column_name in('id','entry_id','organization_id','event_id','amount'))=5 allocations_structure_ok,
    count(*) filter(where table_name='financial_reconciliations' and column_name in('id','entry_id','organization_id','account_id','amount','idempotency_key'))=6 reconciliations_structure_ok,
    count(*) filter(where table_name='financial_reversals' and column_name in('id','organization_id','original_entry_id','reversal_entry_id','amount','idempotency_key'))=6 reversals_structure_ok
  from information_schema.columns where table_schema='public' and table_name like 'financial_%'
), signatures as (
  select
    to_regprocedure('public.upsert_financial_account(uuid,uuid,text,text,text,boolean,text)') is not null has_upsert_account,
    to_regprocedure('public.upsert_financial_category(uuid,uuid,text,text,boolean,text)') is not null has_upsert_category,
    to_regprocedure('public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text)') is not null has_upsert_supplier,
    to_regprocedure('public.create_financial_entry(uuid,text,text,numeric,date,date,uuid,uuid,uuid,jsonb,jsonb,text)') is not null has_create_entry,
    to_regprocedure('public.post_financial_entry(uuid,text)') is not null has_post_entry,
    to_regprocedure('public.reconcile_financial_entry(uuid,uuid,numeric,date,text,text)') is not null has_reconcile_entry,
    to_regprocedure('public.reverse_financial_entry(uuid,numeric,text,text)') is not null has_reverse_entry,
    count(*) filter(where p.proname in('upsert_financial_account','upsert_financial_category','upsert_financial_supplier','create_financial_entry','post_financial_entry','reconcile_financial_entry','reverse_financial_entry')
      and p.oid not in(
        coalesce(to_regprocedure('public.upsert_financial_account(uuid,uuid,text,text,text,boolean,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.upsert_financial_category(uuid,uuid,text,text,boolean,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.create_financial_entry(uuid,text,text,numeric,date,date,uuid,uuid,uuid,jsonb,jsonb,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.post_financial_entry(uuid,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.reconcile_financial_entry(uuid,uuid,numeric,date,text,text)')::oid,'0'::oid),
        coalesce(to_regprocedure('public.reverse_financial_entry(uuid,numeric,text,text)')::oid,'0'::oid)
      ))::integer conflicting_signature_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), definitions as (
  select
    coalesce(pg_get_functiondef(to_regprocedure('public.upsert_financial_account(uuid,uuid,text,text,text,boolean,text)')),'') account_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.upsert_financial_category(uuid,uuid,text,text,boolean,text)')),'') category_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text)')),'') supplier_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.create_financial_entry(uuid,text,text,numeric,date,date,uuid,uuid,uuid,jsonb,jsonb,text)')),'') create_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.post_financial_entry(uuid,text)')),'') post_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.reconcile_financial_entry(uuid,uuid,numeric,date,text,text)')),'') reconcile_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.reverse_financial_entry(uuid,numeric,text,text)')),'') reverse_body
), function_contract as (
  select
    position('security definer' in lower(account_body))>0 and position('security definer' in lower(category_body))>0
      and position('security definer' in lower(supplier_body))>0 and position('security definer' in lower(create_body))>0
      and position('security definer' in lower(post_body))>0 and position('security definer' in lower(reconcile_body))>0
      and position('security definer' in lower(reverse_body))>0 functions_are_protected,
    position('auth.uid()' in lower(account_body))>0 and position('auth.uid()' in lower(category_body))>0
      and position('auth.uid()' in lower(supplier_body))>0 and position('auth.uid()' in lower(create_body))>0
      and position('auth.uid()' in lower(post_body))>0 and position('auth.uid()' in lower(reconcile_body))>0
      and position('auth.uid()' in lower(reverse_body))>0 functions_use_session_actor,
    position('user_can_access_organization' in lower(account_body))>0 and position('user_can_access_organization' in lower(category_body))>0
      and position('user_can_access_organization' in lower(supplier_body))>0 and position('user_can_access_organization' in lower(create_body))>0
      and position('user_can_access_organization' in lower(post_body))>0 and position('user_can_access_organization' in lower(reconcile_body))>0
      and position('user_can_access_organization' in lower(reverse_body))>0 functions_validate_organization,
    position('finance.manage_accounts' in lower(account_body))>0 account_uses_specific_permission,
    position('finance.manage_categories' in lower(category_body))>0 category_uses_specific_permission,
    position('finance.manage_suppliers' in lower(supplier_body))>0 supplier_uses_specific_permission,
    position('finance.manage_entries' in lower(create_body))>0 and position('finance.manage_expenses' in lower(create_body))>0
      and position('finance.manage_income' in lower(create_body))>0 create_uses_entry_type_permissions,
    position('finance.manage_fees' in lower(account_body||category_body||supplier_body||create_body||post_body||reconcile_body||reverse_body))=0 ledger_does_not_reuse_fee_permission,
    position('finance.confirm_payment' in lower(post_body))>0 posting_uses_confirm_permission,
    position('finance.reconcile' in lower(reconcile_body))>0 reconciliation_uses_specific_permission,
    position('finance.refund' in lower(reverse_body))>0 and position('finance.approve_refund' in lower(reverse_body))>0 reversal_uses_either_permission,
    position('financial_entry_created' in lower(create_body))>0 and position('financial_entry_posted' in lower(post_body))>0
      and position('financial_entry_reconciled' in lower(reconcile_body))>0 and position('financial_entry_reversed' in lower(reverse_body))>0 functions_record_audit,
    position('idempotency_key' in lower(account_body||category_body||supplier_body||create_body||reconcile_body||reverse_body))>0 functions_enforce_idempotency,
    position('service_role' in lower(account_body||category_body||supplier_body||create_body||post_body||reconcile_body||reverse_body))=0 functions_do_not_use_service_role
  from definitions
), grants as (
  select count(*) filter(where grantee in('anon','PUBLIC') and privilege_type='EXECUTE')::integer anonymous_ledger_rpc_grant_count
  from information_schema.routine_privileges
  where routine_schema='public' and routine_name in('upsert_financial_account','upsert_financial_category','upsert_financial_supplier','create_financial_entry','post_financial_entry','reconcile_financial_entry','reverse_financial_entry')
), policy_contract as (
  select
    count(*) filter(where tablename in('financial_accounts','financial_categories','financial_suppliers')
      and policyname='financial_ledger_read' and qual ilike '%finance.view%')::integer installed_master_read_policy_count,
    count(*) filter(where tablename in('financial_entries','financial_entry_lines','financial_event_allocations','financial_reconciliations','financial_reversals')
      and policyname='financial_ledger_read' and qual ilike '%finance.view%' and qual ilike '%finance.view_amounts%')::integer installed_amount_read_policy_count
  from pg_policies where schemaname='public'
), installed_data_ambiguities as (
  -- Executa sem referenciar estaticamente as tabelas novas: antes da migration o catálogo retorna zero.
  select
    count(*) filter(where c.relname='financial_entries' and not c.relrowsecurity)::integer ledger_tables_without_rls_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in('financial_accounts','financial_categories','financial_suppliers','financial_entries','financial_entry_lines','financial_event_allocations','financial_reconciliations','financial_reversals')
), states as (
  select
    not (lt.has_financial_accounts or lt.has_financial_categories or lt.has_financial_suppliers or lt.has_financial_entries
      or lt.has_financial_entry_lines or lt.has_financial_event_allocations or lt.has_financial_reconciliations or lt.has_financial_reversals) as clean_previous_state,
    lt.has_financial_accounts and lt.has_financial_categories and lt.has_financial_suppliers and lt.has_financial_entries
      and lt.has_financial_entry_lines and lt.has_financial_event_allocations and lt.has_financial_reconciliations and lt.has_financial_reversals
      and ic.accounts_structure_ok and ic.categories_structure_ok and ic.suppliers_structure_ok and ic.entries_structure_ok
      and ic.lines_structure_ok and ic.allocations_structure_ok and ic.reconciliations_structure_ok and ic.reversals_structure_ok
      and sg.has_upsert_account and sg.has_upsert_category and sg.has_upsert_supplier
      and sg.has_create_entry and sg.has_post_entry and sg.has_reconcile_entry and sg.has_reverse_entry
      and pp.installed_planned_permission_count=pp.planned_permission_count and pp.incompatible_planned_permission_count=0
      and fc.functions_are_protected and fc.functions_use_session_actor and fc.functions_validate_organization
      and fc.account_uses_specific_permission and fc.category_uses_specific_permission and fc.supplier_uses_specific_permission
      and fc.create_uses_entry_type_permissions and fc.ledger_does_not_reuse_fee_permission
      and fc.posting_uses_confirm_permission and fc.reconciliation_uses_specific_permission and fc.reversal_uses_either_permission
      and fc.functions_record_audit and fc.functions_enforce_idempotency and fc.functions_do_not_use_service_role
      and pc.installed_master_read_policy_count=3 and pc.installed_amount_read_policy_count=5
      and g.anonymous_ledger_rpc_grant_count=0 and ida.ledger_tables_without_rls_count=0 as idempotent_installed_state
  from ledger_tables lt cross join installed_columns ic cross join signatures sg cross join function_contract fc cross join grants g cross join policy_contract pc cross join installed_data_ambiguities ida cross join planned_permissions pp
)
select s.*,ec.*,p.*,pcs.*,pp.*,li.*,lt.*,ic.*,sg.*,fc.*,g.*,pc.*,ida.*,st.*,
  s.has_organizations and s.has_events and s.has_payments and s.has_audit_logs and s.has_admin_permissions
    and s.has_permission_resolver and s.has_organization_guard
    and ec.payments_contract_ok and ec.audit_contract_ok and ec.events_contract_ok
    and p.has_finance_view and p.has_finance_view_amounts and p.has_finance_confirm and p.has_finance_refund
    and pcs.admin_permissions_structure_ok and pcs.admin_permissions_code_is_unique
    and pp.planned_permission_count=8 and pp.incompatible_planned_permission_count=0
    and li.payments_without_organization_count=0 and li.payment_event_organization_mismatch_count=0
    and sg.conflicting_signature_count=0 and (st.clean_previous_state or st.idempotent_installed_state) as safe_to_apply
from structure s cross join existing_contract ec cross join permissions p cross join permission_catalog_structure pcs cross join planned_permissions pp cross join legacy_integrity li
cross join ledger_tables lt cross join installed_columns ic cross join signatures sg cross join function_contract fc
cross join grants g cross join policy_contract pc cross join installed_data_ambiguities ida cross join states st;
