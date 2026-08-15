-- 111_confirmed_payments_cash_backfill_diagnostic.sql
-- Estritamente somente leitura: classifica exclusivamente pagamentos confirmados para revisão do backfill de caixa.
with confirmed_payments as (
  select pay.* from public.payments pay where pay.payment_status='paid'
), payment_order_links as (
  select distinct pay.id payment_id,o.id order_id
  from confirmed_payments pay
  join public.orders o on o.id=pay.order_id or o.payment_id=pay.id
), order_paid_payment_counts as (
  select pol.order_id,count(distinct pol.payment_id)::integer paid_payment_count
  from payment_order_links pol group by pol.order_id
), item_context as (
  select pol.payment_id,
    count(distinct oi.id)::integer order_item_count,
    count(distinct oi.ticket_category_id)::integer category_count,
    count(distinct oi.batch_id)::integer batch_count,
    coalesce(jsonb_agg(distinct jsonb_build_object(
      'order_item_id',oi.id,'participant_id',oi.participant_id,'status',oi.status,'quantity',oi.quantity,
      'unit_price',oi.unit_price,'discount_amount',oi.discount_amount,'final_amount',oi.final_amount,
      'category_id',oi.ticket_category_id,'category_name',tc.name,
      'batch_id',oi.batch_id,'batch_name',rb.name
    )) filter(where oi.id is not null),'[]'::jsonb) order_items
  from payment_order_links pol
  left join public.order_items oi on oi.order_id=pol.order_id
  left join public.ticket_categories tc on tc.id=oi.ticket_category_id
  left join public.registration_batches rb on rb.id=oi.batch_id and rb.event_id=oi.event_id
  group by pol.payment_id
), ticket_context as (
  select pol.payment_id,
    count(distinct t.id)::integer issued_ticket_count,
    count(distinct t.participant_id)::integer distinct_ticket_holder_count,
    coalesce(jsonb_agg(distinct jsonb_build_object(
      'ticket_id',t.id,'order_id',t.order_id,'order_item_id',t.order_item_id,'status',t.status,
      'issued_at',t.issued_at,'participant_id',t.participant_id,'holder_user_id',hp.user_id,
      'holder_name',hp.full_name
    )) filter(where t.id is not null),'[]'::jsonb) tickets
  from payment_order_links pol
  left join public.tickets t on t.order_id=pol.order_id
  left join public.participants hp on hp.id=t.participant_id and hp.event_id=t.event_id
  group by pol.payment_id
), order_context as (
  select pol.payment_id,
    count(distinct o.id)::integer related_order_count,
    max(opc.paid_payment_count)::integer maximum_paid_payments_on_same_order,
    min(o.created_at) order_created_at,
    coalesce(jsonb_agg(distinct jsonb_build_object(
      'order_id',o.id,'order_number',o.order_number,'status',o.status,'event_id',o.event_id,
      'organization_id',o.organization_id,'payment_id',o.payment_id,'buyer_user_id',o.user_id,
      'buyer_name',cp.full_name,'buyer_type',o.buyer_type,'created_at',o.created_at,
      'paid_payment_count',opc.paid_payment_count
    )),'[]'::jsonb) orders
  from payment_order_links pol
  join public.orders o on o.id=pol.order_id
  left join order_paid_payment_counts opc on opc.order_id=o.id
  left join public.customer_profiles cp on cp.user_id=o.user_id
  group by pol.payment_id
), gateway_context as (
  select pay.id payment_id,
    case when nullif(pay.gateway_payment_id,'') is null then 0 else count(*) over(partition by pay.gateway_payment_id)::integer end confirmed_gateway_reference_count
  from confirmed_payments pay
), confirmation_audit as (
  select pay.id payment_id,
    count(distinct al.id)::integer confirmation_audit_count,
    coalesce(jsonb_agg(distinct jsonb_build_object(
      'audit_id',al.id,'action',al.action,'created_at',al.created_at,
      'actor_user_id',al.details->>'actor_user_id','previous_status',al.details->>'previous_status',
      'new_status',al.details->>'new_status','reason',al.details->>'reason'
    )) filter(where al.id is not null),'[]'::jsonb) confirmation_audits
  from confirmed_payments pay
  left join public.audit_logs al on al.entity_type='payments' and al.entity_id=pay.id
    and al.action in('payment_admin_confirmed','registration_payment_confirmed','payment_simulated_paid','payment_status_changed')
    and (al.action<>'payment_status_changed' or al.details->>'new_status'='paid')
  group by pay.id
), ledger_catalog as (
  select to_regclass('public.financial_entries') is not null ledger_table_installed
), evidence as (
  select
    pay.id payment_id,pay.participant_id,pay.event_id,pay.organization_id,
    pay.payment_method,pay.payment_status,pay.gateway_payment_id,pay.amount,pay.discount_amount,pay.final_amount,
    pay.created_at payment_created_at,pay.paid_at effective_received_at,
    coalesce(oc.order_created_at,pay.created_at) competency_at,
    e.name event_name,org.name organization_name,
    coalesce(oc.related_order_count,0) related_order_count,coalesce(oc.orders,'[]'::jsonb) orders,
    coalesce(ic.order_item_count,0) order_item_count,coalesce(ic.category_count,0) category_count,
    coalesce(ic.batch_count,0) batch_count,coalesce(ic.order_items,'[]'::jsonb) order_items,
    coalesce(tc.issued_ticket_count,0) issued_ticket_count,
    coalesce(tc.distinct_ticket_holder_count,0) distinct_ticket_holder_count,coalesce(tc.tickets,'[]'::jsonb) tickets,
    coalesce(gc.confirmed_gateway_reference_count,0) confirmed_gateway_reference_count,
    coalesce(ca.confirmation_audit_count,0) confirmation_audit_count,coalesce(ca.confirmation_audits,'[]'::jsonb) confirmation_audits,
    coalesce(oc.maximum_paid_payments_on_same_order,0) maximum_paid_payments_on_same_order,
    lc.ledger_table_installed,
    case when lc.ledger_table_installed then coalesce(((xpath('//count/text()',query_to_xml(
      format('select count(*) as count from public.financial_entries where source_payment_id=%L::uuid',pay.id),false,true,''
    )))[1]::text)::integer,0) else 0 end financial_entry_count
  from confirmed_payments pay
  left join order_context oc on oc.payment_id=pay.id
  left join item_context ic on ic.payment_id=pay.id
  left join ticket_context tc on tc.payment_id=pay.id
  left join gateway_context gc on gc.payment_id=pay.id
  left join confirmation_audit ca on ca.payment_id=pay.id
  left join public.events e on e.id=pay.event_id and e.organization_id=pay.organization_id
  left join public.organizations org on org.id=pay.organization_id
  cross join ledger_catalog lc
), classified as (
  select *,
    related_order_count=1 and order_item_count>0 and maximum_paid_payments_on_same_order=1
      and confirmed_gateway_reference_count<=1 as order_represents_distinct_purchase,
    case
      when financial_entry_count>0 or maximum_paid_payments_on_same_order>1 or confirmed_gateway_reference_count>1
        then 'proven_duplicate'
      when related_order_count=1 and order_item_count>0 and maximum_paid_payments_on_same_order=1
        and confirmed_gateway_reference_count<=1 then 'proven_distinct_sale'
      when related_order_count=0 and confirmed_gateway_reference_count<=1 then 'confirmed_legacy_revenue_without_order'
      else 'ambiguous_manual_review'
    end final_classification
  from evidence
)
select
  count(*) over()::integer confirmed_payment_diagnostic_count,
  payment_id,participant_id,event_id,event_name,organization_id,organization_name,
  payment_method,payment_status,gateway_payment_id,confirmed_gateway_reference_count,
  amount,discount_amount,final_amount,competency_at,effective_received_at,
  related_order_count,orders,order_item_count,order_items,issued_ticket_count,tickets,
  distinct_ticket_holder_count,category_count,batch_count,
  confirmation_audit_count,confirmation_audits,ledger_table_installed,financial_entry_count,
  maximum_paid_payments_on_same_order,order_represents_distinct_purchase,
  final_classification,
  case final_classification
    when 'proven_distinct_sale' then 'Venda distinta comprovada'
    when 'confirmed_legacy_revenue_without_order' then 'Receita confirmada sem pedido legado'
    when 'proven_duplicate' then 'Duplicidade comprovada'
    else 'Ambíguo para revisão manual'
  end final_classification_label,
  final_classification='proven_duplicate' as exclude_from_cash_backfill,
  final_classification in('proven_distinct_sale','confirmed_legacy_revenue_without_order') as eligible_for_cash_backfill,
  true read_only_diagnostic
from classified
order by effective_received_at nulls last,payment_created_at,payment_id;
