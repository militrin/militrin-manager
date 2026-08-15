-- 111_confirmed_payments_cash_backfill.sql
-- Prepara, mas nao executa automaticamente, o backfill dos recebimentos confirmados.
-- A execucao exige UUIDs reais, preflight aprovado e p_apply=true.
begin;

alter table public.financial_entries
  add column if not exists source_order_id uuid references public.orders(id),
  add column if not exists source_participant_id uuid references public.participants(id);

create unique index if not exists uq_financial_entries_source_payment_revenue
  on public.financial_entries(source_payment_id)
  where source_payment_id is not null and entry_kind='revenue';

create or replace view public.confirmed_payments_cash_backfill_111_candidates as
with confirmed as (
  select pay.* from public.payments pay where pay.payment_status='paid'
), links as (
  select distinct pay.id payment_id,o.id order_id,o.created_at order_created_at
  from confirmed pay join public.orders o on o.id=pay.order_id or o.payment_id=pay.id
), per_payment as (
  select pay.id payment_id,count(distinct l.order_id)::integer related_order_count,
    (array_agg(distinct l.order_id order by l.order_id) filter(where l.order_id is not null))[1] order_id,
    min(l.order_created_at) order_created_at,
    count(distinct oi.id)::integer order_item_count
  from confirmed pay left join links l on l.payment_id=pay.id
  left join public.order_items oi on oi.order_id=l.order_id group by pay.id
), per_order as (
  select l.order_id,count(distinct l.payment_id)::integer paid_payment_count from links l group by l.order_id
), gateway as (
  select pay.id payment_id,case when nullif(pay.gateway_payment_id,'') is null then 0
    else count(*) over(partition by pay.gateway_payment_id)::integer end gateway_count from confirmed pay
), classified as (
  select pay.id payment_id,pp.order_id,pay.participant_id,pay.event_id,pay.organization_id,
    pay.final_amount amount,coalesce(pp.order_created_at,pay.created_at)::date competency_on,pay.paid_at effective_at,
    case when pp.related_order_count=1 and pp.order_item_count>0 and coalesce(po.paid_payment_count,0)=1 and g.gateway_count<=1
      then 'proven_distinct_sale'
      when pp.related_order_count=0 and g.gateway_count<=1 then 'confirmed_legacy_revenue_without_order'
      else 'excluded' end classification
  from confirmed pay join per_payment pp on pp.payment_id=pay.id left join per_order po on po.order_id=pp.order_id
  join gateway g on g.payment_id=pay.id
)
select c.*,('cash-backfill-111:payment:'||c.payment_id::text) idempotency_key
from classified c where c.classification in('proven_distinct_sale','confirmed_legacy_revenue_without_order');

revoke all on public.confirmed_payments_cash_backfill_111_candidates from public,anon,authenticated;

create or replace function public.backfill_confirmed_payments_cash_111(
  p_cash_account_id uuid,
  p_revenue_account_id uuid,
  p_revenue_category_id uuid,
  p_created_by uuid,
  p_apply boolean default false
) returns table(
  payment_id uuid,
  order_id uuid,
  participant_id uuid,
  event_id uuid,
  organization_id uuid,
  classification text,
  amount numeric,
  competency_on date,
  effective_at timestamptz,
  idempotency_key text,
  action text
) language plpgsql security invoker set search_path to 'public','pg_temp' as $$
declare
  v_organization_id uuid;
  v_candidate_count integer;
  v_candidate_total numeric(14,2);
  v_sale_count integer;
  v_legacy_count integer;
  v_collision_count integer;
begin
  if p_cash_account_id is null or p_revenue_account_id is null
    or p_revenue_category_id is null or p_created_by is null then
    raise exception 'Informe conta de caixa, conta de receita, categoria de receita e usuario executor.';
  end if;

  select fa.organization_id into v_organization_id
  from public.financial_accounts fa
  where fa.id=p_cash_account_id and fa.account_type='asset' and fa.is_active;
  if v_organization_id is null then
    raise exception 'Conta financeira de destino inexistente, inativa ou nao classificada como ativo.';
  end if;
  if not exists(select 1 from public.financial_accounts fa where fa.id=p_revenue_account_id
    and fa.organization_id=v_organization_id and fa.account_type='revenue' and fa.is_active) then
    raise exception 'Conta de contrapartida inexistente, inativa, fora da organizacao ou nao classificada como receita.';
  end if;
  if not exists(select 1 from public.financial_categories fc where fc.id=p_revenue_category_id
    and fc.organization_id=v_organization_id and fc.entry_kind in('revenue','both') and fc.is_active) then
    raise exception 'Categoria inexistente, inativa, fora da organizacao ou incompativel com receita.';
  end if;
  if not exists(select 1 from auth.users au where au.id=p_created_by) then
    raise exception 'Usuario executor inexistente.';
  end if;

  select count(*),coalesce(sum(c.amount),0),
    count(*) filter(where c.classification='proven_distinct_sale'),
    count(*) filter(where c.classification='confirmed_legacy_revenue_without_order')
  into v_candidate_count,v_candidate_total,v_sale_count,v_legacy_count
  from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id;

  if v_candidate_count<>19 or v_sale_count<>17 or v_legacy_count<>2 or v_candidate_total<>2250.00 then
    raise exception 'Conjunto divergente: total=% (esperado 19), vendas=% (17), legados=% (2), valor=% (2250.00).',
      v_candidate_count,v_sale_count,v_legacy_count,v_candidate_total;
  end if;
  if exists(select 1 from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id and (c.amount<=0 or c.event_id is null
    or c.effective_at is null or c.competency_on is null)) then
    raise exception 'Candidato sem valor positivo, evento, paid_at ou competencia comprovada.';
  end if;
  if exists(select 1 from public.confirmed_payments_cash_backfill_111_candidates c left join public.events e on e.id=c.event_id
    and e.organization_id=c.organization_id where c.organization_id=v_organization_id and e.id is null) then
    raise exception 'Candidato referencia evento fora da organizacao.';
  end if;

  select count(*) into v_collision_count from public.confirmed_payments_cash_backfill_111_candidates c
  join public.financial_entries fe on fe.source_payment_id=c.payment_id
    or (fe.organization_id=c.organization_id and fe.idempotency_key=c.idempotency_key)
  where c.organization_id=v_organization_id;
  if v_collision_count>0 and p_apply then
    raise exception 'Ha % colisao(oes) por source_payment_id ou chave idempotente.',v_collision_count;
  end if;

  if p_apply then
    insert into public.financial_entries(
      organization_id,entry_kind,lifecycle_status,description,category_id,
      source_payment_id,source_order_id,source_participant_id,amount,due_date,occurred_on,
      posted_at,settled_at,currency,idempotency_key,created_by
    )
    select c.organization_id,'revenue','settled',
      case when c.classification='proven_distinct_sale' then 'Receita de venda - pagamento '||c.payment_id::text
        else 'Receita legada confirmada - pagamento '||c.payment_id::text end,
      p_revenue_category_id,c.payment_id,c.order_id,c.participant_id,c.amount,null,c.competency_on,
      c.effective_at,c.effective_at,'BRL',c.idempotency_key,p_created_by
    from public.confirmed_payments_cash_backfill_111_candidates c where c.organization_id=v_organization_id;

    insert into public.financial_entry_lines(entry_id,organization_id,account_id,line_side,amount,memo)
    select fe.id,fe.organization_id,p_cash_account_id,'debit',fe.amount,'Recebimento confirmado'
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id
    union all
    select fe.id,fe.organization_id,p_revenue_account_id,'credit',fe.amount,'Receita de inscricao'
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;

    insert into public.financial_event_allocations(entry_id,organization_id,event_id,amount)
    select fe.id,fe.organization_id,c.event_id,fe.amount from public.financial_entries fe
    join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;

    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    select 'financial_payment_cash_backfilled','financial_entries',fe.id,c.event_id,
      jsonb_build_object('actor_user_id',p_created_by,'organization_id',c.organization_id,
        'payment_id',c.payment_id,'order_id',c.order_id,'participant_id',c.participant_id,
        'classification',c.classification,'amount',c.amount,'competency_on',c.competency_on,
        'effective_at',c.effective_at,'idempotency_key',c.idempotency_key,'migration','111')
    from public.financial_entries fe join public.confirmed_payments_cash_backfill_111_candidates c on c.payment_id=fe.source_payment_id
    where c.organization_id=v_organization_id;
  end if;

  return query select c.payment_id,c.order_id,c.participant_id,c.event_id,c.organization_id,
    c.classification,c.amount,c.competency_on,c.effective_at,c.idempotency_key,
    case when p_apply then 'inserted' when exists(select 1 from public.financial_entries fe
      where fe.source_payment_id=c.payment_id or (fe.organization_id=c.organization_id and fe.idempotency_key=c.idempotency_key))
      then 'collision' else 'would_insert' end
  from public.confirmed_payments_cash_backfill_111_candidates c
  where c.organization_id=v_organization_id order by c.effective_at,c.payment_id;
end $$;

comment on function public.backfill_confirmed_payments_cash_111(uuid,uuid,uuid,uuid,boolean) is
  'Simula (p_apply=false) ou executa explicitamente o backfill validado de 19 pagamentos/BRL 2250 da migration 111.';

revoke all on function public.backfill_confirmed_payments_cash_111(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated;

commit;
