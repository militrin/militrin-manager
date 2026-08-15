-- 112_simple_financial_operations_preflight.sql
-- Estritamente somente leitura: aceita a base 110/111 ou a instalacao idempotente da 112.
with structure as (
  select to_regclass('public.financial_accounts') is not null has_accounts,
    to_regclass('public.financial_entries') is not null has_entries,
    to_regclass('public.financial_entry_lines') is not null has_lines,
    to_regclass('public.financial_event_allocations') is not null has_allocations,
    to_regclass('public.financial_entry_settlements') is not null has_settlements,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard
), signatures as (
  select to_regprocedure('public.ensure_simple_financial_accounts(uuid,text)') is not null has_initializer,
    to_regprocedure('public.create_simple_financial_expense(uuid,text,numeric,date,date,uuid,uuid,uuid,text)') is not null has_expense_creator,
    to_regprocedure('public.settle_simple_financial_expense(uuid,numeric,date,text,text)') is not null has_expense_settlement
), definitions as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.ensure_simple_financial_accounts(uuid,text)')),'') initializer_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.create_simple_financial_expense(uuid,text,numeric,date,date,uuid,uuid,uuid,text)')),'') expense_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.settle_simple_financial_expense(uuid,numeric,date,text,text)')),'') settlement_body
), contract as (
  select position('security definer' in lower(initializer_body||expense_body||settlement_body))>0 protected_functions,
    position('auth.uid()' in lower(initializer_body||expense_body||settlement_body))>0 uses_session_actor,
    position('user_can_access_organization' in lower(initializer_body||expense_body||settlement_body))>0 validates_organization,
    position('finance.manage_accounts' in lower(initializer_body))>0 initializer_rbac,
    position('finance.manage_expenses' in lower(expense_body))>0 expense_rbac,
    position('finance.confirm_payment' in lower(settlement_body))>0 settlement_rbac,
    position('financial_expense_created' in lower(expense_body))>0 and position('financial_expense_settled' in lower(settlement_body))>0 records_audit,
    position('service_role' in lower(initializer_body||expense_body||settlement_body))=0 avoids_service_role
  from definitions
), grants as (
  select count(*) filter(where grantee in('anon','PUBLIC') and privilege_type='EXECUTE')::integer anonymous_execute_count
  from information_schema.routine_privileges where routine_schema='public'
    and routine_name in('ensure_simple_financial_accounts','create_simple_financial_expense','settle_simple_financial_expense')
), installed_structure as (
  select count(*) filter(where table_name='financial_entry_settlements' and column_name in('id','organization_id','expense_entry_id','settlement_entry_id','amount','paid_on','reason','idempotency_key','settled_by','created_at'))=10 settlements_structure_ok
  from information_schema.columns where table_schema='public' and table_name='financial_entry_settlements'
), ambiguities as (
  select count(*) filter(where code in('SYS_CAIXA','SYS_RECEITAS','SYS_DESPESAS','SYS_A_PAGAR') and account_type is distinct from case code when 'SYS_CAIXA' then 'asset' when 'SYS_RECEITAS' then 'revenue' when 'SYS_DESPESAS' then 'expense' when 'SYS_A_PAGAR' then 'liability' end)::integer incompatible_system_account_count
  from public.financial_accounts
)
select s.*,sg.*,c.*,g.*,i.*,a.*,
  not s.has_settlements and not sg.has_initializer and not sg.has_expense_creator and not sg.has_expense_settlement clean_previous_state,
  s.has_settlements and sg.has_initializer and sg.has_expense_creator and sg.has_expense_settlement
    and i.settlements_structure_ok and c.protected_functions and c.uses_session_actor and c.validates_organization
    and c.initializer_rbac and c.expense_rbac and c.settlement_rbac and c.records_audit and c.avoids_service_role
    and g.anonymous_execute_count=0 as idempotent_installed_state,
  s.has_accounts and s.has_entries and s.has_lines and s.has_allocations and s.has_permission_resolver and s.has_organization_guard
    and a.incompatible_system_account_count=0
    and ((not s.has_settlements and not sg.has_initializer and not sg.has_expense_creator and not sg.has_expense_settlement)
      or (s.has_settlements and sg.has_initializer and sg.has_expense_creator and sg.has_expense_settlement
        and i.settlements_structure_ok and c.protected_functions and c.uses_session_actor and c.validates_organization
        and c.initializer_rbac and c.expense_rbac and c.settlement_rbac and c.records_audit and c.avoids_service_role
        and g.anonymous_execute_count=0)) as safe_to_apply,
  true read_only_preflight
from structure s cross join signatures sg cross join definitions d cross join contract c cross join grants g cross join installed_structure i cross join ambiguities a;
