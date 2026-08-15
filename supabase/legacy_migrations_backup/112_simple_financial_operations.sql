-- 112_simple_financial_operations.sql
-- Simplifica a operacao financeira sem cadastrar dados bancarios ou importar pagamentos automaticamente.
begin;

create table if not exists public.financial_entry_settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  expense_entry_id uuid not null,
  settlement_entry_id uuid not null,
  amount numeric(14,2) not null check(amount>0),
  paid_on date not null,
  reason text,
  idempotency_key text not null,
  settled_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financial_settlement_expense_org_fk foreign key(expense_entry_id,organization_id) references public.financial_entries(id,organization_id),
  constraint financial_settlement_entry_org_fk foreign key(settlement_entry_id,organization_id) references public.financial_entries(id,organization_id),
  unique(organization_id,idempotency_key),
  unique(settlement_entry_id)
);

alter table public.financial_entry_settlements enable row level security;
drop policy if exists financial_ledger_read on public.financial_entry_settlements;
create policy financial_ledger_read on public.financial_entry_settlements for select to authenticated using(
  public.user_can_access_organization(auth.uid(),organization_id)
  and public.current_user_has_permission('finance.view')
  and public.current_user_has_permission('finance.view_amounts')
);

create or replace function public.ensure_simple_financial_accounts(p_organization_id uuid,p_idempotency_key text)
returns table(cash_account_id uuid,revenue_account_id uuid,expense_account_id uuid,payable_account_id uuid)
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_accounts')
    or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Referencia da configuracao obrigatoria.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':simple-finance',0));
  insert into public.financial_accounts(organization_id,code,name,account_type,is_active) values
    (p_organization_id,'SYS_CAIXA','Caixa Militrin','asset',true),
    (p_organization_id,'SYS_RECEITAS','Receitas de vendas','revenue',true),
    (p_organization_id,'SYS_DESPESAS','Despesas operacionais','expense',true),
    (p_organization_id,'SYS_A_PAGAR','Contas a pagar','liability',true)
  on conflict(organization_id,code) do nothing;
  if (select count(*) from public.financial_accounts where organization_id=p_organization_id and is_active and (
    (code='SYS_CAIXA' and account_type='asset') or (code='SYS_RECEITAS' and account_type='revenue')
    or (code='SYS_DESPESAS' and account_type='expense') or (code='SYS_A_PAGAR' and account_type='liability')
  ))<>4 then raise exception 'As contas internas existem com configuracao incompativel ou inativa.'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  select 'simple_finance_initialized','organizations',p_organization_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key))
  where not exists(select 1 from public.audit_logs where action='simple_finance_initialized' and entity_id=p_organization_id);
  return query select
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_CAIXA'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_RECEITAS'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_DESPESAS'),
    (select id from public.financial_accounts where organization_id=p_organization_id and code='SYS_A_PAGAR');
end $$;

create or replace function public.create_simple_financial_expense(
  p_organization_id uuid,p_description text,p_amount numeric,p_due_date date,p_occurred_on date,
  p_category_id uuid,p_supplier_id uuid,p_event_id uuid,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_expense uuid; v_payable uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_entries')
    or not public.current_user_has_permission('finance.manage_expenses')
    or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_amount<=0 or p_due_date is null or nullif(trim(p_description),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Descricao, valor e vencimento sao obrigatorios.'; end if;
  select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key); if v_id is not null then return v_id; end if;
  select id into v_expense from public.financial_accounts where organization_id=p_organization_id and code='SYS_DESPESAS' and account_type='expense' and is_active;
  select id into v_payable from public.financial_accounts where organization_id=p_organization_id and code='SYS_A_PAGAR' and account_type='liability' and is_active;
  if v_expense is null or v_payable is null then raise exception 'Inicialize as configuracoes financeiras antes de cadastrar despesas.'; end if;
  if p_category_id is not null and not exists(select 1 from public.financial_categories where id=p_category_id and organization_id=p_organization_id and entry_kind in('expense','both') and is_active) then raise exception 'Categoria de despesa invalida.'; end if;
  if p_supplier_id is not null and not exists(select 1 from public.financial_suppliers where id=p_supplier_id and organization_id=p_organization_id and is_active) then raise exception 'Fornecedor invalido.'; end if;
  if p_event_id is not null and not exists(select 1 from public.events where id=p_event_id and organization_id=p_organization_id) then raise exception 'Evento fora da organizacao.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,category_id,supplier_id,amount,due_date,occurred_on,posted_at,idempotency_key,created_by)
  values(p_organization_id,'expense','open',trim(p_description),p_category_id,p_supplier_id,p_amount,p_due_date,coalesce(p_occurred_on,current_date),now(),trim(p_idempotency_key),v_actor) returning id into v_id;
  insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values
    (v_id,p_organization_id,v_expense,'debit',p_amount,'Despesa reconhecida'),
    (v_id,p_organization_id,v_payable,'credit',p_amount,'Obrigacao a pagar');
  if p_event_id is not null then insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount) values(v_id,p_organization_id,p_event_id,p_amount); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_expense_created','financial_entries',v_id,p_event_id,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'amount',p_amount,'due_date',p_due_date,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.settle_simple_financial_expense(p_entry_id uuid,p_amount numeric,p_paid_on date,p_reason text,p_idempotency_key text)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_expense public.financial_entries%rowtype; v_settlement uuid; v_paid numeric; v_cash uuid; v_payable uuid;
begin
  select * into v_expense from public.financial_entries where id=p_entry_id for update; if not found then raise exception 'Despesa nao encontrada.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.confirm_payment') or not public.user_can_access_organization(v_actor,v_expense.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  select settlement_entry_id into v_settlement from public.financial_entry_settlements where organization_id=v_expense.organization_id and idempotency_key=trim(p_idempotency_key); if v_settlement is not null then return v_settlement; end if;
  if v_expense.entry_kind<>'expense' or v_expense.lifecycle_status not in('open','partially_settled') or p_amount<=0 or p_paid_on is null or nullif(trim(p_reason),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Baixa invalida para a despesa.'; end if;
  select coalesce(sum(amount),0) into v_paid from public.financial_entry_settlements where expense_entry_id=p_entry_id;
  if v_paid+p_amount>v_expense.amount then raise exception 'Pagamento excede o saldo da despesa.'; end if;
  select id into v_cash from public.financial_accounts where organization_id=v_expense.organization_id and code='SYS_CAIXA' and account_type='asset' and is_active;
  select id into v_payable from public.financial_accounts where organization_id=v_expense.organization_id and code='SYS_A_PAGAR' and account_type='liability' and is_active;
  if v_cash is null or v_payable is null then raise exception 'Contas internas indisponiveis.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,original_entry_id,amount,occurred_on,posted_at,settled_at,idempotency_key,created_by)
  values(v_expense.organization_id,'transfer','settled','Pagamento: '||v_expense.description,p_entry_id,p_amount,p_paid_on,now(),now(),'settlement:'||trim(p_idempotency_key),v_actor) returning id into v_settlement;
  insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values
    (v_settlement,v_expense.organization_id,v_payable,'debit',p_amount,'Baixa da obrigacao'),
    (v_settlement,v_expense.organization_id,v_cash,'credit',p_amount,'Pagamento da despesa');
  insert into public.financial_entry_settlements(organization_id,expense_entry_id,settlement_entry_id,amount,paid_on,reason,idempotency_key,settled_by)
  values(v_expense.organization_id,p_entry_id,v_settlement,p_amount,p_paid_on,trim(p_reason),trim(p_idempotency_key),v_actor);
  update public.financial_entries set lifecycle_status=case when v_paid+p_amount=amount then 'settled' else 'partially_settled' end,settled_at=case when v_paid+p_amount=amount then now() else null end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_expense_settled','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_expense.organization_id,'settlement_entry_id',v_settlement,'amount',p_amount,'paid_on',p_paid_on,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_settlement;
end $$;

revoke all on table public.financial_entry_settlements from public,anon;
grant select on table public.financial_entry_settlements to authenticated;
revoke all on function public.ensure_simple_financial_accounts(uuid,text) from public,anon,authenticated;
revoke all on function public.create_simple_financial_expense(uuid,text,numeric,date,date,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.settle_simple_financial_expense(uuid,numeric,date,text,text) from public,anon,authenticated;
grant execute on function public.ensure_simple_financial_accounts(uuid,text) to authenticated;
grant execute on function public.create_simple_financial_expense(uuid,text,numeric,date,date,uuid,uuid,uuid,text) to authenticated;
grant execute on function public.settle_simple_financial_expense(uuid,numeric,date,text,text) to authenticated;

commit;
