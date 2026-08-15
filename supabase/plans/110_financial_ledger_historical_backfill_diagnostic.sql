-- 110_financial_ledger_historical_backfill_diagnostic.sql
-- Estritamente somente leitura: inventaria candidatos; não cria lançamentos no livro.
with payment_orders as (
  select pay.id payment_id,
    count(distinct o.id)::integer related_order_count,
    coalesce(jsonb_agg(distinct jsonb_build_object('order_id',o.id,'order_number',o.order_number,'status',o.status))
      filter(where o.id is not null),'[]'::jsonb) related_orders,
    min(o.created_at) order_created_at
  from public.payments pay
  left join public.orders o on o.id=pay.order_id or o.payment_id=pay.id
  group by pay.id
), candidates as (
  select
    pay.id payment_id,pay.participant_id,pay.event_id,pay.organization_id,
    pay.payment_status,pay.payment_method,pay.amount,pay.discount_amount,pay.final_amount,
    pay.created_at payment_created_at,pay.paid_at effective_received_at,
    coalesce(po.order_created_at,pay.created_at) competency_at,
    e.name event_name,o.name organization_name,
    po.related_order_count,po.related_orders,
    count(*) over(partition by pay.organization_id,pay.event_id,pay.participant_id,pay.final_amount,pay.payment_status)::integer equivalent_payment_count,
    case when nullif(pay.gateway_payment_id,'') is null then 0
      else count(*) over(partition by nullif(pay.gateway_payment_id,''))::integer end gateway_reference_count
  from public.payments pay
  left join payment_orders po on po.payment_id=pay.id
  left join public.events e on e.id=pay.event_id and e.organization_id=pay.organization_id
  left join public.organizations o on o.id=pay.organization_id
), classified as (
  select *,
    payment_status='paid' as is_confirmed,
    payment_status='pending' as is_pending,
    payment_status='expired' as is_expired,
    related_order_count=1 as has_single_related_order,
    related_order_count>1 as has_ambiguous_related_order,
    equivalent_payment_count>1 or gateway_reference_count>1 or related_order_count>1 as possible_duplicate,
    case
      when payment_status='paid' and effective_received_at is null then 'confirmed_without_effective_date'
      when payment_status='paid' and related_order_count=0 then 'confirmed_without_order'
      when related_order_count>1 then 'ambiguous_order'
      when equivalent_payment_count>1 or gateway_reference_count>1 then 'possible_duplicate'
      when payment_status='paid' then 'confirmed_candidate'
      when payment_status='pending' then 'pending_not_candidate'
      when payment_status='expired' then 'expired_not_candidate'
      else 'other_status_not_candidate'
    end historical_classification
  from candidates
)
select
  count(*)::integer total_payment_count,
  count(*) filter(where is_confirmed)::integer confirmed_payment_count,
  count(*) filter(where is_pending)::integer pending_payment_count,
  count(*) filter(where is_expired)::integer expired_payment_count,
  count(*) filter(where related_order_count=0)::integer without_related_order_count,
  count(*) filter(where has_ambiguous_related_order)::integer ambiguous_related_order_count,
  count(*) filter(where possible_duplicate)::integer possible_duplicate_count,
  count(*) filter(where historical_classification='confirmed_candidate')::integer clean_confirmed_candidate_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'payment_id',payment_id,'participant_id',participant_id,'event_id',event_id,'event_name',event_name,
    'organization_id',organization_id,'organization_name',organization_name,'payment_status',payment_status,
    'payment_method',payment_method,'amount',amount,'discount_amount',discount_amount,'final_amount',final_amount,
    'competency_at',competency_at,'effective_received_at',effective_received_at,'related_order_count',related_order_count,
    'related_orders',related_orders,'equivalent_payment_count',equivalent_payment_count,
    'gateway_reference_count',gateway_reference_count,'possible_duplicate',possible_duplicate,
    'historical_classification',historical_classification
  ) order by payment_created_at,payment_id),'[]'::jsonb) payment_diagnostics,
  true as read_only_diagnostic
from classified;
