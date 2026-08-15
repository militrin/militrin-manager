-- 110_financial_ledger_foundation.sql
-- Fundação canônica do livro financeiro. Não importa, altera ou reclassifica dados existentes.
begin;

do $$
declare v_conflicts integer;
begin
  with permission_plan(code,name,description,module,sort_order,is_active) as (values
    ('finance.manage_accounts','Gerenciar contas financeiras','Cria e altera o plano de contas financeiro','finance',70,true),
    ('finance.manage_categories','Gerenciar categorias financeiras','Cria e altera categorias de receitas e despesas','finance',80,true),
    ('finance.manage_suppliers','Gerenciar fornecedores','Cria e altera fornecedores financeiros','finance',90,true),
    ('finance.manage_entries','Gerenciar lancamentos','Cria receitas, despesas, transferencias e ajustes','finance',100,true),
    ('finance.manage_expenses','Gerenciar despesas','Autoriza a criacao de despesas','finance',110,true),
    ('finance.manage_income','Gerenciar receitas','Autoriza a criacao de receitas','finance',120,true),
    ('finance.reconcile','Conciliar financeiro','Registra conciliacoes financeiras','finance',130,true),
    ('finance.approve_refund','Aprovar estornos','Aprova estornos financeiros sem ampliar a permissao legada','finance',140,true)
  )
  select count(*) into v_conflicts from permission_plan p join public.admin_permissions ap using(code)
  where ap.name<>p.name or ap.description is distinct from p.description or ap.module<>p.module
    or ap.sort_order<>p.sort_order or ap.is_active<>p.is_active;
  if v_conflicts>0 then raise exception 'Existem permissoes financeiras 110 com definicoes incompativeis: %.',v_conflicts; end if;
end $$;

insert into public.admin_permissions(code,name,description,module,sort_order,is_active) values
  ('finance.manage_accounts','Gerenciar contas financeiras','Cria e altera o plano de contas financeiro','finance',70,true),
  ('finance.manage_categories','Gerenciar categorias financeiras','Cria e altera categorias de receitas e despesas','finance',80,true),
  ('finance.manage_suppliers','Gerenciar fornecedores','Cria e altera fornecedores financeiros','finance',90,true),
  ('finance.manage_entries','Gerenciar lancamentos','Cria receitas, despesas, transferencias e ajustes','finance',100,true),
  ('finance.manage_expenses','Gerenciar despesas','Autoriza a criacao de despesas','finance',110,true),
  ('finance.manage_income','Gerenciar receitas','Autoriza a criacao de receitas','finance',120,true),
  ('finance.reconcile','Conciliar financeiro','Registra conciliacoes financeiras','finance',130,true),
  ('finance.approve_refund','Aprovar estornos','Aprova estornos financeiros sem ampliar a permissao legada','finance',140,true)
on conflict(code) do nothing;

create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  code text not null,
  name text not null,
  account_type text not null check (account_type in ('asset','liability','equity','revenue','expense')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table if not exists public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  entry_kind text not null check (entry_kind in ('revenue','expense','both')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (id, organization_id)
);

create table if not exists public.financial_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  legal_name text not null,
  display_name text,
  tax_identifier text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, tax_identifier),
  unique (id, organization_id)
);

create table if not exists public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  entry_kind text not null check (entry_kind in ('revenue','expense','transfer','adjustment','reversal')),
  lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft','open','partially_settled','settled','cancelled','partially_reversed','reversed')),
  description text not null,
  category_id uuid,
  supplier_id uuid,
  source_payment_id uuid references public.payments(id),
  original_entry_id uuid,
  amount numeric(14,2) not null check (amount > 0),
  due_date date,
  occurred_on date not null default current_date,
  posted_at timestamptz,
  settled_at timestamptz,
  cancelled_at timestamptz,
  currency text not null default 'BRL' check (currency = 'BRL'),
  idempotency_key text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_entries_category_org_fk foreign key(category_id,organization_id) references public.financial_categories(id,organization_id),
  constraint financial_entries_supplier_org_fk foreign key(supplier_id,organization_id) references public.financial_suppliers(id,organization_id),
  constraint financial_entries_original_fk foreign key(original_entry_id) references public.financial_entries(id),
  unique (organization_id, idempotency_key),
  unique (id, organization_id)
);

create table if not exists public.financial_entry_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  organization_id uuid not null,
  account_id uuid not null,
  line_side text not null check (line_side in ('debit','credit')),
  amount numeric(14,2) not null check (amount > 0),
  memo text,
  created_at timestamptz not null default now(),
  constraint financial_lines_entry_org_fk foreign key(entry_id,organization_id) references public.financial_entries(id,organization_id) on delete cascade,
  constraint financial_lines_account_org_fk foreign key(account_id,organization_id) references public.financial_accounts(id,organization_id)
);

create table if not exists public.financial_event_allocations (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  organization_id uuid not null,
  event_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint financial_alloc_entry_org_fk foreign key(entry_id,organization_id) references public.financial_entries(id,organization_id) on delete cascade,
  constraint financial_alloc_event_fk foreign key(event_id) references public.events(id),
  unique (entry_id,event_id)
);

create table if not exists public.financial_reconciliations (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  organization_id uuid not null,
  account_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  reconciled_on date not null,
  external_reference text,
  idempotency_key text not null,
  reconciled_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financial_rec_entry_org_fk foreign key(entry_id,organization_id) references public.financial_entries(id,organization_id),
  constraint financial_rec_account_org_fk foreign key(account_id,organization_id) references public.financial_accounts(id,organization_id),
  unique (organization_id,idempotency_key)
);

create table if not exists public.financial_reversals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  original_entry_id uuid not null,
  reversal_entry_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  reason text not null,
  idempotency_key text not null,
  reversed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint financial_reversal_original_org_fk foreign key(original_entry_id,organization_id) references public.financial_entries(id,organization_id),
  constraint financial_reversal_entry_org_fk foreign key(reversal_entry_id,organization_id) references public.financial_entries(id,organization_id),
  unique (organization_id,idempotency_key),
  unique (reversal_entry_id)
);

create index if not exists idx_financial_entries_org_due on public.financial_entries(organization_id,due_date) where lifecycle_status in ('open','partially_settled');
create index if not exists idx_financial_entries_org_kind on public.financial_entries(organization_id,entry_kind,lifecycle_status);
create index if not exists idx_financial_allocations_event on public.financial_event_allocations(organization_id,event_id);
create index if not exists idx_financial_reconciliations_entry on public.financial_reconciliations(entry_id);
create index if not exists idx_financial_reversals_original on public.financial_reversals(original_entry_id);

alter table public.financial_accounts enable row level security;
alter table public.financial_categories enable row level security;
alter table public.financial_suppliers enable row level security;
alter table public.financial_entries enable row level security;
alter table public.financial_entry_lines enable row level security;
alter table public.financial_event_allocations enable row level security;
alter table public.financial_reconciliations enable row level security;
alter table public.financial_reversals enable row level security;

do $$
declare v_table text;
begin
  foreach v_table in array array['financial_accounts','financial_categories','financial_suppliers','financial_entries','financial_entry_lines','financial_event_allocations','financial_reconciliations','financial_reversals']
  loop
    execute format('drop policy if exists %I on public.%I','financial_ledger_read',v_table);
    if v_table in('financial_accounts','financial_categories','financial_suppliers') then
      execute format('create policy %I on public.%I for select to authenticated using (public.user_can_access_organization(auth.uid(),organization_id) and public.current_user_has_permission(''finance.view''))','financial_ledger_read',v_table);
    else
      execute format('create policy %I on public.%I for select to authenticated using (public.user_can_access_organization(auth.uid(),organization_id) and public.current_user_has_permission(''finance.view'') and public.current_user_has_permission(''finance.view_amounts''))','financial_ledger_read',v_table);
    end if;
  end loop;
end $$;

create or replace function public.upsert_financial_account(p_organization_id uuid,p_account_id uuid,p_code text,p_name text,p_account_type text,p_is_active boolean,p_idempotency_key text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_accounts') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_account_type not in('asset','liability','equity','revenue','expense') or nullif(trim(p_code),'') is null or nullif(trim(p_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Conta financeira invalida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':account:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_account_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1; if v_id is not null then return v_id; end if;
  if p_account_id is null then insert into public.financial_accounts(organization_id,code,name,account_type,is_active) values(p_organization_id,trim(p_code),trim(p_name),p_account_type,coalesce(p_is_active,true)) on conflict(organization_id,code) do update set name=excluded.name,account_type=excluded.account_type,is_active=excluded.is_active,updated_at=now() returning id into v_id;
  else update public.financial_accounts set code=trim(p_code),name=trim(p_name),account_type=p_account_type,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_account_id and organization_id=p_organization_id returning id into v_id; if v_id is null then raise exception 'Conta financeira nao encontrada.'; end if; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_account_upserted','financial_accounts',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.upsert_financial_category(p_organization_id uuid,p_category_id uuid,p_name text,p_entry_kind text,p_is_active boolean,p_idempotency_key text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_categories') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_entry_kind not in('revenue','expense','both') or nullif(trim(p_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Categoria financeira invalida.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':category:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_category_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1; if v_id is not null then return v_id; end if;
  if p_category_id is null then insert into public.financial_categories(organization_id,name,entry_kind,is_active) values(p_organization_id,trim(p_name),p_entry_kind,coalesce(p_is_active,true)) on conflict(organization_id,name) do update set entry_kind=excluded.entry_kind,is_active=excluded.is_active,updated_at=now() returning id into v_id;
  else update public.financial_categories set name=trim(p_name),entry_kind=p_entry_kind,is_active=coalesce(p_is_active,true),updated_at=now() where id=p_category_id and organization_id=p_organization_id returning id into v_id; if v_id is null then raise exception 'Categoria financeira nao encontrada.'; end if; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_category_upserted','financial_categories',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.upsert_financial_supplier(p_organization_id uuid,p_supplier_id uuid,p_legal_name text,p_display_name text,p_tax_identifier text,p_is_active boolean,p_idempotency_key text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('finance.manage_suppliers') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if nullif(trim(p_legal_name),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Fornecedor invalido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':supplier:'||trim(p_idempotency_key),0));
  select entity_id into v_id from public.audit_logs where action='financial_supplier_upserted' and details->>'organization_id'=p_organization_id::text and details->>'idempotency_key'=trim(p_idempotency_key) order by created_at limit 1; if v_id is not null then return v_id; end if;
  if p_supplier_id is null then insert into public.financial_suppliers(organization_id,legal_name,display_name,tax_identifier,is_active) values(p_organization_id,trim(p_legal_name),nullif(trim(p_display_name),''),nullif(regexp_replace(p_tax_identifier,'[^0-9]','','g'),''),coalesce(p_is_active,true)) on conflict(organization_id,tax_identifier) do update set legal_name=excluded.legal_name,display_name=excluded.display_name,is_active=excluded.is_active,updated_at=now() returning id into v_id;
  else update public.financial_suppliers set legal_name=trim(p_legal_name),display_name=nullif(trim(p_display_name),''),tax_identifier=nullif(regexp_replace(p_tax_identifier,'[^0-9]','','g'),''),is_active=coalesce(p_is_active,true),updated_at=now() where id=p_supplier_id and organization_id=p_organization_id returning id into v_id; if v_id is null then raise exception 'Fornecedor nao encontrado.'; end if; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_supplier_upserted','financial_suppliers',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.create_financial_entry(
  p_organization_id uuid,p_entry_kind text,p_description text,p_amount numeric,p_due_date date,
  p_occurred_on date,p_category_id uuid,p_supplier_id uuid,p_source_payment_id uuid,
  p_lines jsonb,p_allocations jsonb,p_idempotency_key text
) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_debits numeric; v_credits numeric; v_allocated numeric; v_item jsonb;
begin
  if v_actor is null then raise exception 'Nao autenticado.'; end if;
  if not public.current_user_has_permission('finance.manage_entries') or not public.user_can_access_organization(v_actor,p_organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if p_entry_kind='expense' and not public.current_user_has_permission('finance.manage_expenses') then raise exception 'Sem permissao para criar despesas.'; end if;
  if p_entry_kind='revenue' and not public.current_user_has_permission('finance.manage_income') then raise exception 'Sem permissao para criar receitas.'; end if;
  if p_entry_kind not in('revenue','expense','transfer','adjustment') or p_amount<=0 or nullif(trim(p_description),'') is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'Dados do lancamento invalidos.'; end if;
  select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key);
  if v_id is not null then return v_id; end if;
  if p_source_payment_id is not null and not exists(select 1 from public.payments where id=p_source_payment_id and organization_id=p_organization_id) then raise exception 'Pagamento fora da organizacao.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,description,category_id,supplier_id,source_payment_id,amount,due_date,occurred_on,idempotency_key,created_by)
  values(p_organization_id,p_entry_kind,trim(p_description),p_category_id,p_supplier_id,p_source_payment_id,p_amount,p_due_date,coalesce(p_occurred_on,current_date),trim(p_idempotency_key),v_actor) returning id into v_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) loop
    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo)
    values(v_id,p_organization_id,(v_item->>'account_id')::uuid,v_item->>'side',(v_item->>'amount')::numeric,nullif(v_item->>'memo',''));
  end loop;
  select coalesce(sum(amount) filter(where line_side='debit'),0),coalesce(sum(amount) filter(where line_side='credit'),0) into v_debits,v_credits from public.financial_entry_lines where entry_id=v_id;
  if v_debits<>p_amount or v_credits<>p_amount then raise exception 'Partida dobrada desequilibrada: debitos e creditos devem coincidir com o total.'; end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_allocations,'[]'::jsonb)) loop
    if not exists(select 1 from public.events where id=(v_item->>'event_id')::uuid and organization_id=p_organization_id) then raise exception 'Evento do rateio fora da organizacao.'; end if;
    insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount) values(v_id,p_organization_id,(v_item->>'event_id')::uuid,(v_item->>'amount')::numeric);
  end loop;
  select coalesce(sum(amount),0) into v_allocated from public.financial_event_allocations where entry_id=v_id;
  if v_allocated>p_amount then raise exception 'Rateio excede o valor do lancamento.'; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_created','financial_entries',v_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',p_organization_id,'entry_kind',p_entry_kind,'amount',p_amount,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
exception when unique_violation then select id into v_id from public.financial_entries where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key); return v_id;
end $$;

create or replace function public.post_financial_entry(p_entry_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_d numeric; v_c numeric;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.confirm_payment') or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  if v_entry.lifecycle_status<>'draft' then return v_entry.id; end if;
  select coalesce(sum(amount) filter(where line_side='debit'),0),coalesce(sum(amount) filter(where line_side='credit'),0) into v_d,v_c from public.financial_entry_lines where entry_id=p_entry_id;
  if v_d<>v_entry.amount or v_c<>v_entry.amount then raise exception 'Lancamento desequilibrado.'; end if;
  update public.financial_entries set lifecycle_status=case when due_date is null or due_date<=current_date then 'settled' else 'open' end,posted_at=now(),settled_at=case when due_date is null or due_date<=current_date then now() end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_posted','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'previous_status','draft','reason',nullif(trim(p_reason),'')));
  return p_entry_id;
end $$;

create or replace function public.reconcile_financial_entry(p_entry_id uuid,p_account_id uuid,p_amount numeric,p_reconciled_on date,p_external_reference text,p_idempotency_key text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_id uuid; v_total numeric;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not public.current_user_has_permission('finance.reconcile') or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso financeiro negado.'; end if;
  select id into v_id from public.financial_reconciliations where organization_id=v_entry.organization_id and idempotency_key=trim(p_idempotency_key); if v_id is not null then return v_id; end if;
  if v_entry.lifecycle_status not in('open','partially_settled','settled') or p_amount<=0 then raise exception 'Conciliação invalida para o estado atual.'; end if;
  insert into public.financial_reconciliations(entry_id,organization_id,account_id,amount,reconciled_on,external_reference,idempotency_key,reconciled_by) values(p_entry_id,v_entry.organization_id,p_account_id,p_amount,p_reconciled_on,nullif(trim(p_external_reference),''),trim(p_idempotency_key),v_actor) returning id into v_id;
  select sum(amount) into v_total from public.financial_reconciliations where entry_id=p_entry_id;
  if v_total>v_entry.amount then raise exception 'Conciliacao excede o valor do lancamento.'; end if;
  update public.financial_entries set lifecycle_status=case when v_total=v_entry.amount then 'settled' else 'partially_settled' end,settled_at=case when v_total=v_entry.amount then now() else null end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_reconciled','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'reconciliation_id',v_id,'amount',p_amount,'idempotency_key',trim(p_idempotency_key)));
  return v_id;
end $$;

create or replace function public.reverse_financial_entry(p_entry_id uuid,p_amount numeric,p_reason text,p_idempotency_key text) returns uuid language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare v_actor uuid:=auth.uid(); v_entry public.financial_entries%rowtype; v_reversal uuid; v_reversed numeric; v_line record; v_line_amount numeric; v_debit_remaining numeric:=p_amount; v_credit_remaining numeric:=p_amount;
begin
  select * into v_entry from public.financial_entries where id=p_entry_id for update;
  if not found then raise exception 'Lancamento nao encontrado.'; end if;
  if v_actor is null or not (public.current_user_has_permission('finance.refund') or public.current_user_has_permission('finance.approve_refund')) or not public.user_can_access_organization(v_actor,v_entry.organization_id) then raise exception 'Acesso a estorno negado.'; end if;
  select reversal_entry_id into v_reversal from public.financial_reversals where organization_id=v_entry.organization_id and idempotency_key=trim(p_idempotency_key); if v_reversal is not null then return v_reversal; end if;
  if p_amount<=0 or nullif(trim(p_reason),'') is null or v_entry.lifecycle_status in('draft','cancelled','reversed') then raise exception 'Estorno invalido.'; end if;
  select coalesce(sum(amount),0) into v_reversed from public.financial_reversals where original_entry_id=p_entry_id;
  if v_reversed+p_amount>v_entry.amount then raise exception 'Estorno excede o saldo do lancamento.'; end if;
  insert into public.financial_entries(organization_id,entry_kind,lifecycle_status,description,original_entry_id,amount,occurred_on,posted_at,settled_at,idempotency_key,created_by) values(v_entry.organization_id,'reversal','settled','Estorno: '||v_entry.description,p_entry_id,p_amount,current_date,now(),now(),'reversal:'||trim(p_idempotency_key),v_actor) returning id into v_reversal;
  for v_line in select l.*,row_number() over(partition by line_side order by id) line_number,count(*) over(partition by line_side) line_count from public.financial_entry_lines l where entry_id=p_entry_id order by line_side,id loop
    v_line_amount:=case
      when v_line.line_side='debit' and v_line.line_number=v_line.line_count then v_debit_remaining
      when v_line.line_side='credit' and v_line.line_number=v_line.line_count then v_credit_remaining
      else round(v_line.amount*p_amount/v_entry.amount,2)
    end;
    if v_line_amount<=0 then raise exception 'Estorno parcial pequeno demais para o rateio contabil.'; end if;
    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo) values(v_reversal,v_entry.organization_id,v_line.account_id,case v_line.line_side when 'debit' then 'credit' else 'debit' end,v_line_amount,'Estorno proporcional');
    if v_line.line_side='debit' then v_debit_remaining:=v_debit_remaining-v_line_amount; else v_credit_remaining:=v_credit_remaining-v_line_amount; end if;
  end loop;
  if v_debit_remaining<>0 or v_credit_remaining<>0 then raise exception 'Rateio contabil do estorno produziu arredondamento nao balanceado.'; end if;
  insert into public.financial_reversals(organization_id,original_entry_id,reversal_entry_id,amount,reason,idempotency_key,reversed_by) values(v_entry.organization_id,p_entry_id,v_reversal,p_amount,trim(p_reason),trim(p_idempotency_key),v_actor);
  update public.financial_entries set lifecycle_status=case when v_reversed+p_amount=v_entry.amount then 'reversed' else 'partially_reversed' end,updated_at=now() where id=p_entry_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('financial_entry_reversed','financial_entries',p_entry_id,null,jsonb_build_object('actor_user_id',v_actor,'organization_id',v_entry.organization_id,'reversal_entry_id',v_reversal,'amount',p_amount,'reason',trim(p_reason),'idempotency_key',trim(p_idempotency_key)));
  return v_reversal;
end $$;

revoke all on function public.create_financial_entry(uuid,text,text,numeric,date,date,uuid,uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.upsert_financial_account(uuid,uuid,text,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.upsert_financial_category(uuid,uuid,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.post_financial_entry(uuid,text) from public,anon,authenticated;
revoke all on function public.reconcile_financial_entry(uuid,uuid,numeric,date,text,text) from public,anon,authenticated;
revoke all on function public.reverse_financial_entry(uuid,numeric,text,text) from public,anon,authenticated;
grant execute on function public.create_financial_entry(uuid,text,text,numeric,date,date,uuid,uuid,uuid,jsonb,jsonb,text) to authenticated;
grant execute on function public.upsert_financial_account(uuid,uuid,text,text,text,boolean,text) to authenticated;
grant execute on function public.upsert_financial_category(uuid,uuid,text,text,boolean,text) to authenticated;
grant execute on function public.upsert_financial_supplier(uuid,uuid,text,text,text,boolean,text) to authenticated;
grant execute on function public.post_financial_entry(uuid,text) to authenticated;
grant execute on function public.reconcile_financial_entry(uuid,uuid,numeric,date,text,text) to authenticated;
grant execute on function public.reverse_financial_entry(uuid,numeric,text,text) to authenticated;

commit;
