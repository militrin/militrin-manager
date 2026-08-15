-- Diagnostico somente leitura. Execute antes da 089 quando forem necessarios
-- os totais reais do ambiente; nenhuma linha e alterada.
select 'historical_participant_category_usage' diagnostic,
  count(*) filter(where p.ticket_category_id is not null) participants_with_legacy_category,
  count(*) filter(where p.ticket_category_id is not null and not exists(
    select 1 from public.order_items oi
    where oi.participant_id=p.id and oi.ticket_category_id=p.ticket_category_id
  )) participants_depending_only_on_legacy_category
from public.participants p;

select 'order_item_category_completeness' diagnostic,
  count(*) total_order_items,
  count(*) filter(where ticket_category_id is null) missing_ticket_category,
  count(*) filter(where ticket_category_id is not null) with_ticket_category
from public.order_items;

select 'multiple_ticket_compatibility' diagnostic,
  to_regclass('public.ux_tickets_participant_id') is not null as legacy_unique_index_exists,
  count(*) filter(where participant_id is not null) as tickets_with_participant
from public.tickets;
