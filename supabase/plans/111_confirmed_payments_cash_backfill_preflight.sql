-- 111_confirmed_payments_cash_backfill_preflight.sql
-- Estritamente somente leitura. Substitua os quatro NULLs por UUIDs reais antes de executar.
-- Nao chama a funcao de backfill e nao grava dados, mesmo quando o resultado for safe_to_apply=true.
with parameters as (
  select
    null::uuid cash_account_id,       -- conta ativa do tipo asset (ex.: Caixa/Banco)
    null::uuid revenue_account_id,    -- conta ativa do tipo revenue (contrapartida contabil)
    null::uuid revenue_category_id,   -- categoria ativa revenue/both (ex.: Inscricoes)
    null::uuid created_by             -- usuario real que respondera pela execucao
), structure as (
  select
    to_regclass('public.financial_entries') is not null has_entries,
    to_regclass('public.financial_entry_lines') is not null has_lines,
    to_regclass('public.financial_event_allocations') is not null has_allocations,
    to_regprocedure('public.backfill_confirmed_payments_cash_111(uuid,uuid,uuid,uuid,boolean)') is not null has_backfill_function
), confirmed as (
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
), candidates as (
  select pay.id payment_id,pp.order_id,pay.participant_id,pay.event_id,pay.organization_id,
    pay.final_amount amount,coalesce(pp.order_created_at,pay.created_at)::date competency_on,pay.paid_at effective_at,
    case when pp.related_order_count=1 and pp.order_item_count>0 and coalesce(po.paid_payment_count,0)=1 and g.gateway_count<=1
      then 'proven_distinct_sale'
      when pp.related_order_count=0 and g.gateway_count<=1 then 'confirmed_legacy_revenue_without_order'
      else 'excluded' end classification,
    'cash-backfill-111:payment:'||pay.id::text idempotency_key
  from confirmed pay join per_payment pp on pp.payment_id=pay.id left join per_order po on po.order_id=pp.order_id
  join gateway g on g.payment_id=pay.id
), eligible as (
  select * from candidates where classification in('proven_distinct_sale','confirmed_legacy_revenue_without_order')
), collisions as (
  select e.payment_id,fe.id financial_entry_id,
    fe.source_payment_id=e.payment_id source_payment_collision,
    fe.organization_id=e.organization_id and fe.idempotency_key=e.idempotency_key idempotency_collision
  from eligible e join public.financial_entries fe on fe.source_payment_id=e.payment_id
    or (fe.organization_id=e.organization_id and fe.idempotency_key=e.idempotency_key)
), metrics as (
  select count(*)::integer candidate_count,coalesce(sum(amount),0)::numeric(14,2) candidate_total,
    count(*) filter(where classification='proven_distinct_sale')::integer sale_count,
    count(*) filter(where classification='confirmed_legacy_revenue_without_order')::integer legacy_count,
    count(*) filter(where effective_at is null)::integer missing_paid_at_count,
    count(*) filter(where competency_on is null)::integer missing_competency_count,
    count(*) filter(where event_id is null)::integer missing_event_count,
    count(distinct event_id)::integer event_count,
    coalesce(jsonb_agg(distinct jsonb_build_object('event_id',event_id,'amount',event_total))
      filter(where event_id is not null),'[]'::jsonb) event_totals
  from (select e.*,sum(e.amount) over(partition by e.event_id) event_total from eligible e) x
), validation as (
  select p.*,s.*,m.*,
    (select count(*) from collisions)::integer collision_count,
    exists(select 1 from public.financial_accounts a where a.id=p.cash_account_id and a.is_active and a.account_type='asset') cash_account_valid,
    exists(select 1 from public.financial_accounts a where a.id=p.revenue_account_id and a.is_active
      and a.account_type='revenue' and a.organization_id=(select organization_id from public.financial_accounts where id=p.cash_account_id)) revenue_account_valid,
    exists(select 1 from public.financial_categories c where c.id=p.revenue_category_id and c.is_active
      and c.entry_kind in('revenue','both') and c.organization_id=(select organization_id from public.financial_accounts where id=p.cash_account_id)) revenue_category_valid,
    exists(select 1 from auth.users u where u.id=p.created_by) created_by_valid,
    not exists(select 1 from eligible e left join public.events ev on ev.id=e.event_id and ev.organization_id=e.organization_id where ev.id is null) events_valid,
    (select count(distinct organization_id) from eligible)=1
      and not exists(
        select 1
        from eligible e
        where e.organization_id is distinct from (
          select a.organization_id from public.financial_accounts a where a.id=p.cash_account_id
        )
      ) organization_valid
  from parameters p cross join structure s cross join metrics m
)
select *,
  has_entries and has_lines and has_allocations and has_backfill_function
  and cash_account_id is not null and revenue_account_id is not null and revenue_category_id is not null and created_by is not null
  and cash_account_valid and revenue_account_valid and revenue_category_valid and created_by_valid
  and organization_valid and events_valid and collision_count=0
  and candidate_count=19 and sale_count=17 and legacy_count=2 and candidate_total=2250.00
  and missing_paid_at_count=0 and missing_competency_count=0 and missing_event_count=0 as safe_to_apply,
  (select coalesce(jsonb_agg(jsonb_build_object('payment_id',payment_id,'financial_entry_id',financial_entry_id,
    'source_payment_collision',source_payment_collision,'idempotency_collision',idempotency_collision)),'[]'::jsonb) from collisions) collision_details,
  true read_only_preflight
from validation;

-- Depois de safe_to_apply=true, simule (continua sem gravar):
-- select * from public.backfill_confirmed_payments_cash_111(
--   '<cash_account_uuid>','<revenue_account_uuid>','<category_uuid>','<executor_user_uuid>',false
-- );
-- A execucao com p_apply=true deve ocorrer apenas em janela controlada e apos revisar as 19 linhas simuladas.
