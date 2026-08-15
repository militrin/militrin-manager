-- 087_ticket_kit_items_zero_candidates.sql
-- Detalha participant_kit_items que nao possuem ticket candidato para a 087.
-- Script estritamente somente leitura, destinado a execucao antes da migration 087.

-- RESULTADO 1: uma linha por vinculo sem ticket candidato.
with candidate_links as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), zero_candidates as (
  select pki.*
  from public.participant_kit_items pki
  where not exists (
    select 1
    from candidate_links c
    where c.participant_kit_item_id = pki.id
  )
), facts as (
  select
    pki.id as participant_kit_item_id,
    pki.participant_id,
    p.full_name as participant_name,
    pki.event_id,
    e.name as event_name,
    pki.kit_item_id,
    eki.name as kit_item_name,
    pki.status,
    pki.delivered_at,
    case when coalesce(order_item_facts.total, 0) = 1
      then order_item_facts.only_order_item_id end as current_order_item_id,
    coalesce(ticket_facts.rows, '[]'::jsonb) as participant_event_tickets,
    coalesce(order_item_facts.rows, '[]'::jsonb) as participant_event_order_items,
    coalesce(order_facts.rows, '[]'::jsonb) as related_orders,
    array(
      select distinct source_value
      from unnest(
        coalesce(history_facts.sources, array[]::text[])
        || case when coalesce(order_facts.has_import, false)
             then array['import']::text[] else array[]::text[] end
      ) source_value
      order by source_value
    ) as registration_sources,
    array(
      select distinct batch_id
      from unnest(
        coalesce(history_facts.import_batch_ids, array[]::uuid[])
        || coalesce(order_facts.import_batch_ids, array[]::uuid[])
      ) batch_id
      order by batch_id
    ) as import_batch_ids,
    coalesce(ticket_facts.total, 0) as ticket_count,
    coalesce(order_item_facts.total, 0) as order_item_count,
    coalesce(order_item_facts.without_ticket, 0) as order_items_without_ticket,
    coalesce(order_facts.total, 0) as order_count,
    coalesce(order_facts.without_order_item, 0) as orders_without_order_item,
    (coalesce(history_facts.has_import, false) or coalesce(order_facts.has_import, false))
      as has_import_origin
  from zero_candidates pki
  left join public.participants p on p.id = pki.participant_id
  left join public.events e on e.id = pki.event_id
  left join public.event_kit_items eki on eki.id = pki.kit_item_id
  left join lateral (
    select
      count(*)::integer as total,
      jsonb_agg(
        jsonb_build_object(
          'ticket_id', x.ticket_id,
          'order_id', x.order_id,
          'order_item_id', x.order_item_id,
          'ticket_participant_id', x.ticket_participant_id,
          'order_item_participant_id', x.order_item_participant_id,
          'status', x.status,
          'issued_at', x.issued_at
        ) order by x.issued_at, x.ticket_id
      ) as rows
    from (
      select
        t.id as ticket_id,
        t.order_id,
        t.order_item_id,
        t.participant_id as ticket_participant_id,
        oi.participant_id as order_item_participant_id,
        t.status,
        t.issued_at
      from public.tickets t
      left join public.order_items oi on oi.id = t.order_item_id
      where t.event_id = pki.event_id
        and (
          t.participant_id = pki.participant_id
          or oi.participant_id = pki.participant_id
          or exists (
            select 1
            from public.orders related_order
            where related_order.id = coalesce(t.order_id, oi.order_id)
              and related_order.participant_id = pki.participant_id
          )
        )
    ) x
  ) ticket_facts on true
  left join lateral (
    select
      count(*)::integer as total,
      (array_agg(x.order_item_id order by x.order_item_id))[1] as only_order_item_id,
      count(*) filter (
        where not exists (
          select 1 from public.tickets linked_ticket
          where linked_ticket.order_item_id = x.order_item_id
        )
      )::integer as without_ticket,
      jsonb_agg(
        jsonb_build_object(
          'order_item_id', x.order_item_id,
          'order_id', x.order_id,
          'participant_id', x.participant_id,
          'status', x.status,
          'ownership_status', x.ownership_status,
          'shirt_type', x.shirt_type,
          'shirt_size', x.shirt_size,
          'ticket_ids', x.ticket_ids
        ) order by x.created_at, x.order_item_id
      ) as rows
    from (
      select
        oi.id as order_item_id,
        oi.order_id,
        oi.participant_id,
        oi.status,
        oi.ownership_status,
        oi.shirt_type,
        oi.shirt_size,
        oi.created_at,
        coalesce((
          select jsonb_agg(t.id order by t.id)
          from public.tickets t where t.order_item_id = oi.id
        ), '[]'::jsonb) as ticket_ids
      from public.order_items oi
      where oi.event_id = pki.event_id
        and (
          oi.participant_id = pki.participant_id
          or exists (
            select 1 from public.orders o
            where o.id = oi.order_id and o.participant_id = pki.participant_id
          )
        )
    ) x
  ) order_item_facts on true
  left join lateral (
    select
      count(*)::integer as total,
      bool_or(x.buyer_type = 'imported_holder' or x.import_batch_id is not null) as has_import,
      array_agg(distinct x.import_batch_id order by x.import_batch_id)
        filter (where x.import_batch_id is not null) as import_batch_ids,
      count(*) filter (
        where not exists (
          select 1 from public.order_items oi where oi.order_id = x.order_id
        )
      )::integer as without_order_item,
      jsonb_agg(
        jsonb_build_object(
          'order_id', x.order_id,
          'order_number', x.order_number,
          'status', x.status,
          'buyer_type', x.buyer_type,
          'import_batch_id', x.import_batch_id,
          'direct_participant_id', x.direct_participant_id,
          'order_item_ids', x.order_item_ids,
          'ticket_ids', x.ticket_ids
        ) order by x.created_at, x.order_id
      ) as rows
    from (
      select distinct
        o.id as order_id,
        o.order_number,
        o.status,
        o.buyer_type,
        o.import_batch_id,
        o.participant_id as direct_participant_id,
        o.created_at,
        coalesce((
          select jsonb_agg(oi.id order by oi.id)
          from public.order_items oi where oi.order_id = o.id
        ), '[]'::jsonb) as order_item_ids,
        coalesce((
          select jsonb_agg(t.id order by t.id)
          from public.tickets t where t.order_id = o.id
        ), '[]'::jsonb) as ticket_ids
      from public.orders o
      where o.event_id = pki.event_id
        and (
          o.participant_id = pki.participant_id
          or exists (
            select 1 from public.order_items oi
            where oi.order_id = o.id and oi.participant_id = pki.participant_id
          )
        )
    ) x
  ) order_facts on true
  left join lateral (
    select
      array_agg(distinct ph.source order by ph.source) as sources,
      array_agg(distinct ph.import_batch_id order by ph.import_batch_id)
        filter (where ph.import_batch_id is not null) as import_batch_ids,
      bool_or(ph.source = 'import' or ph.import_batch_id is not null) as has_import
    from public.participation_history ph
    where ph.participant_id = pki.participant_id
      and ph.event_id = pki.event_id
  ) history_facts on true
), classified as (
  select
    facts.*,
    case
      when has_import_origin and ticket_count = 0
        then '5. participante importado sem emissao de ticket'
      when order_count = 0
        then '1. participante sem pedido'
      when order_item_count = 0
        then '2. pedido sem order_item'
      when order_items_without_ticket > 0 and ticket_count = 0
        then '3. order_item sem ticket'
      when ticket_count > 0
        then '4. ticket existe, mas vinculo historico nao permite provar correspondencia'
      else '6. outro motivo'
    end as category,
    case
      when has_import_origin and ticket_count = 0 and order_item_count = 0
        then 'participation_history comprova importacao, mas nao existe ticket nem order_item relacionado ao participante no evento'
      when has_import_origin and ticket_count = 0 and order_items_without_ticket > 0
        then 'participation_history comprova importacao e existe order_item relacionado, mas nenhum ticket foi emitido para ele'
      when order_count = 0
        then 'nao existe orders ligado diretamente ao participante nem por order_items no mesmo evento'
      when order_item_count = 0
        then 'existe pedido relacionado, mas ele nao possui order_item comprovadamente ligado ao participante'
      when order_items_without_ticket > 0 and ticket_count = 0
        then 'existe order_item comprovadamente ligado ao participante, mas nao existe ticket com esse order_item_id'
      when ticket_count > 0
        then 'existem tickets relacionados pelo pedido legado, mas ticket.participant_id e order_item.participant_id nao comprovam que o kit pertence a um ticket especifico'
      else 'os relacionamentos atuais nao formam uma cadeia participante -> order_item -> ticket comprovavel'
    end as no_candidate_reason,
    case
      when order_item_count = 1 and order_items_without_ticket = 1 and ticket_count = 0
        then 'Emitir o ticket para o unico order_item UUID comprovado; depois associar este vinculo ao ticket gerado preservando o mesmo ID e status.'
      when order_count = 1 and order_item_count = 0
        then 'Revisar o pedido e materializar seu order_item somente se categoria, valores e camiseta puderem ser comprovados; depois emitir o ticket.'
      when ticket_count > 0
        then 'Nao associar automaticamente. Recuperar order_item_id/ticket_id por auditoria ou documento de origem; sem essa prova, manter como legado sem ticket_id.'
      when has_import_origin
        then 'Reprocessar a emissao importada a partir do import_batch_id somente se a linha original identificar deterministicamente pedido e order_item.'
      else 'Investigar auditoria e origem. Sem UUID ou cadeia relacional comprovavel, manter como legado sem ticket_id.'
    end as correction_recommendation,
    (order_item_count = 1 and order_items_without_ticket = 1 and ticket_count = 0)
      as deterministically_correctable_after_ticket_issuance,
    (ticket_count > 0 or (order_count = 0 and not has_import_origin))
      as should_remain_legacy_without_ticket_id_without_more_evidence
  from facts
)
select
  participant_kit_item_id,
  participant_id,
  participant_name,
  event_id,
  event_name,
  kit_item_id,
  kit_item_name,
  status,
  delivered_at,
  current_order_item_id,
  participant_event_tickets,
  participant_event_order_items,
  related_orders,
  registration_sources as registration_origin,
  import_batch_ids,
  category,
  no_candidate_reason,
  correction_recommendation,
  deterministically_correctable_after_ticket_issuance,
  should_remain_legacy_without_ticket_id_without_more_evidence
from classified
order by category, event_name, participant_name, participant_kit_item_id;

-- RESULTADO 2: resumo por categoria, incluindo a decisao operacional sugerida.
with candidate_links as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), zero_candidates as (
  select pki.*
  from public.participant_kit_items pki
  where not exists (
    select 1 from candidate_links c where c.participant_kit_item_id = pki.id
  )
), counts as (
  select
    pki.id,
    (
      exists (
        select 1 from public.participation_history ph
        where ph.participant_id = pki.participant_id
          and ph.event_id = pki.event_id
          and (ph.source = 'import' or ph.import_batch_id is not null)
      )
      or exists (
        select 1 from public.orders imported_order
        where imported_order.event_id = pki.event_id
          and (imported_order.buyer_type = 'imported_holder' or imported_order.import_batch_id is not null)
          and (
            imported_order.participant_id = pki.participant_id
            or exists (
              select 1 from public.order_items imported_item
              where imported_item.order_id = imported_order.id
                and imported_item.participant_id = pki.participant_id
            )
          )
      )
    ) as has_import_origin,
    (select count(*) from public.orders o
      where o.event_id = pki.event_id and (
        o.participant_id = pki.participant_id
        or exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.participant_id = pki.participant_id)
      ))::integer as order_count,
    (select count(*) from public.order_items oi
      where oi.event_id = pki.event_id and (
        oi.participant_id = pki.participant_id
        or exists (select 1 from public.orders o where o.id = oi.order_id and o.participant_id = pki.participant_id)
      ))::integer as order_item_count,
    (select count(*) from public.order_items oi
      where oi.event_id = pki.event_id
        and (oi.participant_id = pki.participant_id
          or exists (select 1 from public.orders o where o.id = oi.order_id and o.participant_id = pki.participant_id))
        and not exists (select 1 from public.tickets t where t.order_item_id = oi.id)
      )::integer as order_items_without_ticket,
    (select count(*) from public.tickets t
      left join public.order_items oi on oi.id = t.order_item_id
      where t.event_id = pki.event_id and (
        t.participant_id = pki.participant_id
        or oi.participant_id = pki.participant_id
        or exists (select 1 from public.orders o where o.id = coalesce(t.order_id, oi.order_id) and o.participant_id = pki.participant_id)
      ))::integer as ticket_count
  from zero_candidates pki
), classified as (
  select
    counts.*,
    case
      when has_import_origin and ticket_count = 0
        then '5. participante importado sem emissao de ticket'
      when order_count = 0
        then '1. participante sem pedido'
      when order_item_count = 0
        then '2. pedido sem order_item'
      when order_items_without_ticket > 0 and ticket_count = 0
        then '3. order_item sem ticket'
      when ticket_count > 0
        then '4. ticket existe, mas vinculo historico nao permite provar correspondencia'
      else '6. outro motivo'
    end as category,
    (order_item_count = 1 and order_items_without_ticket = 1 and ticket_count = 0)
      as deterministically_correctable,
    (ticket_count > 0 or (order_count = 0 and not has_import_origin))
      as requires_legacy_preservation
  from counts
)
select
  category,
  count(*)::bigint as total,
  count(*) filter (where deterministically_correctable)::bigint
    as deterministically_correctable_after_ticket_issuance,
  count(*) filter (where requires_legacy_preservation)::bigint
    as should_remain_legacy_without_more_evidence,
  array_agg(id order by id) as participant_kit_item_ids
from classified
group by category
order by category;
