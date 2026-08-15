-- 087_ticket_kit_items_preflight.sql
-- Preflight somente leitura para 087_ticket_kit_items_operational_ownership.sql.
-- Pode ser executado antes da migration 087: nao referencia as futuras colunas
-- participant_kit_items.ticket_id e participant_kit_items.order_item_id.

-- 1. Total de vinculos atuais.
select
  '01_total_participant_kit_items'::text as diagnostic,
  count(*)::bigint as total
from public.participant_kit_items;

-- 2. Distribuicao completa por status; os tres esperados aparecem mesmo com zero.
with statuses(status) as (
  values ('reserved'::text), ('confirmed'::text), ('delivered'::text)
  union
  select distinct pki.status from public.participant_kit_items pki
)
select
  '02_count_by_status'::text as diagnostic,
  s.status,
  count(pki.id)::bigint as total,
  (s.status in ('reserved', 'confirmed', 'delivered')) as known_status
from statuses s
left join public.participant_kit_items pki on pki.status = s.status
group by s.status
order by
  case s.status when 'reserved' then 1 when 'confirmed' then 2 when 'delivered' then 3 else 4 end,
  s.status;

-- Base de candidatos usada pela 087: somente relacoes UUID reais no mesmo evento.
-- As consultas 3 a 7 repetem esta CTE para permanecerem independentes e somente leitura.

-- 3 e 4. Associacoes inequivocas e distribuicao por quantidade de candidatos.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), candidate_counts as (
  select pki.id, count(c.ticket_id)::integer as candidate_count
  from public.participant_kit_items pki
  left join candidates c on c.participant_kit_item_id = pki.id
  group by pki.id
)
select
  '03_04_candidate_distribution'::text as diagnostic,
  case
    when candidate_count = 0 then 'zero_candidates'
    when candidate_count = 1 then 'exactly_one_candidate'
    else 'multiple_candidates'
  end as candidate_class,
  count(*)::bigint as total,
  count(*) filter (where candidate_count = 1)::bigint as unambiguously_associable
from candidate_counts
group by 2
order by min(candidate_count);

-- 5. Casos ambiguos, com todos os tickets e order_items candidatos.
with candidates as (
  select distinct
    pki.id as participant_kit_item_id,
    t.id as ticket_id,
    t.order_item_id,
    case
      when oi.participant_id = pki.participant_id and t.participant_id = pki.participant_id
        then 'ticket.participant_id e order_item.participant_id apontam para o participante'
      when oi.participant_id = pki.participant_id
        then 'order_item.participant_id aponta para o participante'
      else 'ticket.participant_id legado aponta para o participante'
    end as evidence
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), grouped as (
  select
    participant_kit_item_id,
    array_agg(ticket_id order by ticket_id) as candidate_ticket_ids,
    array_agg(distinct order_item_id order by order_item_id)
      filter (where order_item_id is not null) as candidate_order_item_ids,
    array_agg(distinct evidence order by evidence) as evidence,
    count(*)::integer as candidate_count
  from candidates
  group by participant_kit_item_id
)
select
  '05_ambiguous_links'::text as diagnostic,
  pki.id as participant_kit_item_id,
  pki.participant_id,
  pki.event_id,
  pki.kit_item_id,
  pki.status,
  pki.delivered_at,
  g.candidate_ticket_ids,
  coalesce(g.candidate_order_item_ids, array[]::uuid[]) as candidate_order_item_ids,
  concat(
    'mais de um ticket possui vinculo UUID real com o participante no mesmo evento; evidencias=',
    array_to_string(g.evidence, ' | ')
  ) as ambiguity_reason
from grouped g
join public.participant_kit_items pki on pki.id = g.participant_kit_item_id
where g.candidate_count > 1
order by pki.event_id, pki.participant_id, pki.id;

-- 6. Conflitos projetados para (ticket_id, kit_item_id) e
-- (order_item_id, kit_item_id), considerando apenas associacoes inequivocas.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id, t.order_item_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), resolved as (
  select
    participant_kit_item_id,
    (array_agg(ticket_id order by ticket_id))[1] as ticket_id,
    (array_agg(order_item_id order by order_item_id)
      filter (where order_item_id is not null))[1] as order_item_id
  from candidates
  group by participant_kit_item_id
  having count(*) = 1
), projected as (
  select pki.id, pki.kit_item_id, r.ticket_id, r.order_item_id
  from public.participant_kit_items pki
  join resolved r on r.participant_kit_item_id = pki.id
), conflicts as (
  select
    'ticket_id + kit_item_id'::text as future_unique_key,
    ticket_id as owner_id,
    kit_item_id,
    array_agg(id order by id) as participant_kit_item_ids,
    count(*)::integer as conflict_count
  from projected
  group by ticket_id, kit_item_id
  having count(*) > 1
  union all
  select
    'order_item_id + kit_item_id'::text,
    order_item_id,
    kit_item_id,
    array_agg(id order by id),
    count(*)::integer
  from projected
  where order_item_id is not null
  group by order_item_id, kit_item_id
  having count(*) > 1
)
select '06_future_uniqueness_conflicts'::text as diagnostic, *
from conflicts
order by future_unique_key, owner_id, kit_item_id;

-- 7. Entregas que continuariam sem ticket depois do backfill seguro.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), candidate_counts as (
  select pki.id, count(c.ticket_id)::integer as candidate_count
  from public.participant_kit_items pki
  left join candidates c on c.participant_kit_item_id = pki.id
  group by pki.id
)
select
  '07_delivered_without_resolved_ticket'::text as diagnostic,
  count(*)::bigint as total
from public.participant_kit_items pki
join candidate_counts cc on cc.id = pki.id
where pki.status = 'delivered'
  and cc.candidate_count <> 1;

-- 8. Participantes ligados a mais de um ticket ativo no mesmo evento.
select
  '08_participants_with_multiple_tickets'::text as diagnostic,
  resolved.participant_id,
  t.event_id,
  array_agg(t.id order by t.id) as ticket_ids,
  array_agg(t.order_item_id order by t.order_item_id)
    filter (where t.order_item_id is not null) as order_item_ids,
  count(*)::integer as ticket_count
from public.tickets t
left join public.order_items oi on oi.id = t.order_item_id
cross join lateral (
  select coalesce(oi.participant_id, t.participant_id) as participant_id
) resolved
where resolved.participant_id is not null
  and t.status <> 'cancelled'
group by resolved.participant_id, t.event_id
having count(*) > 1
order by t.event_id, resolved.participant_id;

-- 9. Tickets sem order_item.
select
  '09_tickets_without_order_item'::text as diagnostic,
  t.id as ticket_id,
  t.order_id,
  t.event_id,
  t.participant_id,
  t.status,
  t.issued_at
from public.tickets t
where t.order_item_id is null
order by t.event_id, t.issued_at, t.id;

-- 10. Order items que ainda nao possuem ticket.
select
  '10_order_items_without_ticket'::text as diagnostic,
  oi.id as order_item_id,
  oi.order_id,
  oi.event_id,
  oi.participant_id,
  oi.status,
  oi.ownership_status,
  oi.shirt_type,
  oi.shirt_size,
  oi.created_at
from public.order_items oi
where not exists (
  select 1 from public.tickets t where t.order_item_id = oi.id
)
order by oi.event_id, oi.created_at, oi.id;

-- 11 e 12. Tickets sem titular, separados pela completude da camiseta no order_item.
select
  '11_12_unassigned_ticket_shirt_data'::text as diagnostic,
  case
    when nullif(trim(oi.shirt_type), '') is not null
     and nullif(trim(oi.shirt_size), '') is not null
      then 'has_shirt_type_and_size'
    else 'missing_shirt_type_or_size'
  end as shirt_data_class,
  count(*)::bigint as total,
  array_agg(t.id order by t.id) as ticket_ids
from public.tickets t
join public.order_items oi on oi.id = t.order_item_id
where oi.participant_id is null
  and t.participant_id is null
  and t.status <> 'cancelled'
group by 2
order by 2;

-- 13. Divergencias de event_id em toda a cadeia projetada.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), resolved as (
  select participant_kit_item_id,
    (array_agg(ticket_id order by ticket_id))[1] as ticket_id
  from candidates
  group by participant_kit_item_id
  having count(*) = 1
)
select
  '13_event_id_divergences'::text as diagnostic,
  pki.id as participant_kit_item_id,
  r.ticket_id,
  t.order_id,
  t.order_item_id,
  pki.participant_id,
  pki.event_id as participant_kit_item_event_id,
  t.event_id as ticket_event_id,
  o.event_id as order_event_id,
  oi.event_id as order_item_event_id,
  p.event_id as participant_event_id,
  eki.event_id as kit_item_event_id
from public.participant_kit_items pki
left join resolved r on r.participant_kit_item_id = pki.id
left join public.tickets t on t.id = r.ticket_id
left join public.order_items oi on oi.id = t.order_item_id
left join public.orders o on o.id = coalesce(t.order_id, oi.order_id)
left join public.participants p on p.id = pki.participant_id
left join public.event_kit_items eki on eki.id = pki.kit_item_id
where pki.event_id is distinct from p.event_id
   or pki.event_id is distinct from eki.event_id
   or (r.ticket_id is not null and (
        pki.event_id is distinct from t.event_id
     or t.event_id is distinct from o.event_id
     or t.event_id is distinct from oi.event_id
   ))
union all
select
  '13_event_id_divergences'::text,
  null::uuid,
  t.id,
  t.order_id,
  t.order_item_id,
  coalesce(oi.participant_id, t.participant_id),
  null::uuid,
  t.event_id,
  o.event_id,
  oi.event_id,
  p.event_id,
  null::uuid
from public.tickets t
left join public.order_items oi on oi.id = t.order_item_id
left join public.orders o on o.id = coalesce(t.order_id, oi.order_id)
left join public.participants p on p.id = coalesce(oi.participant_id, t.participant_id)
where t.event_id is distinct from o.event_id
   or (oi.id is not null and t.event_id is distinct from oi.event_id)
   or (p.id is not null and t.event_id is distinct from p.event_id)
order by participant_kit_item_id nulls last, ticket_id;

-- 14. Divergencias de organization_id entre evento, ticket, pedido,
-- participante, item configurado e vinculo de kit.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), resolved as (
  select participant_kit_item_id,
    (array_agg(ticket_id order by ticket_id))[1] as ticket_id
  from candidates
  group by participant_kit_item_id
  having count(*) = 1
)
select
  '14_organization_id_divergences'::text as diagnostic,
  pki.id as participant_kit_item_id,
  r.ticket_id,
  pki.organization_id as participant_kit_item_organization_id,
  e.organization_id as event_organization_id,
  t.organization_id as ticket_organization_id,
  o.organization_id as order_organization_id,
  p.organization_id as participant_organization_id,
  eki.organization_id as kit_item_organization_id
from public.participant_kit_items pki
join public.events e on e.id = pki.event_id
left join resolved r on r.participant_kit_item_id = pki.id
left join public.tickets t on t.id = r.ticket_id
left join public.orders o on o.id = t.order_id
left join public.participants p on p.id = pki.participant_id
left join public.event_kit_items eki on eki.id = pki.kit_item_id
where pki.organization_id is distinct from e.organization_id
   or p.organization_id is distinct from e.organization_id
   or eki.organization_id is distinct from e.organization_id
   or (r.ticket_id is not null and (
        t.organization_id is distinct from e.organization_id
     or o.organization_id is distinct from e.organization_id
   ))
union all
select
  '14_organization_id_divergences'::text,
  null::uuid,
  t.id,
  null::uuid,
  e.organization_id,
  t.organization_id,
  o.organization_id,
  p.organization_id,
  null::uuid
from public.tickets t
left join public.events e on e.id = t.event_id
left join public.order_items oi on oi.id = t.order_item_id
left join public.orders o on o.id = coalesce(t.order_id, oi.order_id)
left join public.participants p on p.id = coalesce(oi.participant_id, t.participant_id)
where t.organization_id is distinct from e.organization_id
   or o.organization_id is distinct from e.organization_id
   or (p.id is not null and p.organization_id is distinct from e.organization_id)
order by participant_kit_item_id nulls last, ticket_id;

-- 15a. Tabelas e colunas que precisam existir antes da 087.
with expected(table_name, column_name) as (
  values
    ('participant_kit_items', 'id'),
    ('participant_kit_items', 'participant_id'),
    ('participant_kit_items', 'event_id'),
    ('participant_kit_items', 'organization_id'),
    ('participant_kit_items', 'kit_item_id'),
    ('participant_kit_items', 'variant_data'),
    ('participant_kit_items', 'quantity'),
    ('participant_kit_items', 'status'),
    ('participant_kit_items', 'delivered_at'),
    ('participant_kit_items', 'created_at'),
    ('tickets', 'id'),
    ('tickets', 'order_id'),
    ('tickets', 'order_item_id'),
    ('tickets', 'participant_id'),
    ('tickets', 'event_id'),
    ('tickets', 'organization_id'),
    ('tickets', 'token'),
    ('tickets', 'status'),
    ('tickets', 'issued_at'),
    ('order_items', 'id'),
    ('order_items', 'order_id'),
    ('order_items', 'participant_id'),
    ('order_items', 'event_id'),
    ('order_items', 'status'),
    ('order_items', 'ownership_status'),
    ('order_items', 'shirt_type'),
    ('order_items', 'shirt_size'),
    ('orders', 'id'),
    ('orders', 'event_id'),
    ('orders', 'organization_id'),
    ('participants', 'id'),
    ('participants', 'event_id'),
    ('participants', 'organization_id'),
    ('event_kit_items', 'id'),
    ('event_kit_items', 'event_id'),
    ('event_kit_items', 'organization_id')
), checked as (
  select
    e.table_name,
    e.column_name,
    (c.column_name is not null) as exists_now
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
)
select '15a_required_columns'::text as diagnostic, *
from checked
order by exists_now, table_name, column_name;

-- 15a-2. Contrato exato das colunas usadas pelos INSERTs da 087.
-- ownership_status pertence a order_items, nao a tickets. A ultima linha deve
-- retornar exists_now=false; todas as linhas required=true devem retornar true.
with insert_columns(statement_name, table_name, column_name, required) as (
  values
    ('repair_order', 'orders', 'user_id', true),
    ('repair_order', 'orders', 'participant_id', true),
    ('repair_order', 'orders', 'event_id', true),
    ('repair_order', 'orders', 'payment_id', true),
    ('repair_order', 'orders', 'order_number', true),
    ('repair_order', 'orders', 'status', true),
    ('repair_order', 'orders', 'base_amount', true),
    ('repair_order', 'orders', 'discount_amount', true),
    ('repair_order', 'orders', 'final_amount', true),
    ('repair_order', 'orders', 'buyer_type', true),
    ('repair_order', 'orders', 'import_batch_id', true),
    ('repair_order', 'orders', 'confirmed_at', true),
    ('repair_order_item', 'order_items', 'order_id', true),
    ('repair_order_item', 'order_items', 'event_id', true),
    ('repair_order_item', 'order_items', 'participant_id', true),
    ('repair_order_item', 'order_items', 'ownership_status', true),
    ('repair_order_item', 'order_items', 'holder_full_name', true),
    ('repair_order_item', 'order_items', 'ticket_category_id', true),
    ('repair_order_item', 'order_items', 'batch_id', true),
    ('repair_order_item', 'order_items', 'shirt_type', true),
    ('repair_order_item', 'order_items', 'shirt_size', true),
    ('repair_order_item', 'order_items', 'quantity', true),
    ('repair_order_item', 'order_items', 'unit_price', true),
    ('repair_order_item', 'order_items', 'discount_amount', true),
    ('repair_order_item', 'order_items', 'final_amount', true),
    ('repair_order_item', 'order_items', 'status', true),
    ('repair_order_item', 'order_items', 'reservation_expires_at', true),
    ('repair_ticket', 'tickets', 'order_id', true),
    ('repair_ticket', 'tickets', 'order_item_id', true),
    ('repair_ticket', 'tickets', 'participant_id', true),
    ('repair_ticket', 'tickets', 'event_id', true),
    ('repair_ticket', 'tickets', 'organization_id', true),
    ('repair_ticket', 'tickets', 'token', true),
    ('repair_ticket', 'tickets', 'status', true),
    ('repair_ticket', 'tickets', 'issued_at', true),
    ('kit_links', 'participant_kit_items', 'ticket_id', false),
    ('kit_links', 'participant_kit_items', 'order_item_id', false),
    ('kit_links', 'participant_kit_items', 'participant_id', true),
    ('kit_links', 'participant_kit_items', 'event_id', true),
    ('kit_links', 'participant_kit_items', 'organization_id', true),
    ('kit_links', 'participant_kit_items', 'kit_item_id', true),
    ('kit_links', 'participant_kit_items', 'variant_data', true),
    ('kit_links', 'participant_kit_items', 'quantity', true),
    ('kit_links', 'participant_kit_items', 'status', true),
    ('forbidden_ticket_column', 'tickets', 'ownership_status', false)
), checked as (
  select i.*,
    exists (
      select 1 from information_schema.columns c
      where c.table_schema='public' and c.table_name=i.table_name
        and c.column_name=i.column_name
    ) as exists_now
  from insert_columns i
)
select '15a2_insert_column_contract'::text as diagnostic, *,
  case
    when statement_name='forbidden_ticket_column' then not exists_now
    when table_name='participant_kit_items' and column_name in ('ticket_id','order_item_id')
      then true -- criadas no inicio da propria 087
    else exists_now
  end as contract_ok
from checked
order by contract_ok, statement_name, table_name, column_name;

-- 15a-3. Fonte do status/defaults de tickets e funcoes locais de emissao.
-- Confirma o CHECK atual, valores reais e se token/issued_at possuem default.
select '15a3_ticket_status_values'::text as diagnostic,
  t.status, count(*)::bigint as total
from public.tickets t
group by t.status
order by t.status;

select '15a3_ticket_schema_contract'::text as diagnostic,
  c.column_name, c.is_nullable, c.column_default
from information_schema.columns c
where c.table_schema='public' and c.table_name='tickets'
  and c.column_name in ('participant_id','token','status','issued_at')
order by c.ordinal_position;

select '15a3_ticket_check_constraints'::text as diagnostic,
  pc.conname, pg_get_constraintdef(pc.oid) as current_definition
from pg_constraint pc
where pc.conrelid='public.tickets'::regclass and pc.contype='c'
order by pc.conname;

select '15a3_canonical_ticket_issuers'::text as diagnostic,
  p.oid::regprocedure::text as function_name,
  pg_get_functiondef(p.oid) as current_definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in (
    'confirm_order_and_issue_ticket',
    'confirm_order_item_and_issue_ticket',
    'confirm_order_payment_and_issue_tickets',
    'create_imported_order_and_issue_ticket'
  )
order by function_name;

-- 15b. Constraints/FKs preexistentes usadas ou substituidas pela 087.
with expected(object_type, table_name, object_name) as (
  values
    ('constraint', 'participant_kit_items', 'participant_kit_items_pkey'),
    ('constraint', 'participant_kit_items', 'participant_kit_items_participant_id_fkey'),
    ('constraint', 'participant_kit_items', 'participant_kit_items_event_id_fkey'),
    ('constraint', 'participant_kit_items', 'participant_kit_items_kit_item_id_fkey'),
    ('constraint', 'participant_kit_items', 'participant_kit_items_quantity_positive'),
    ('constraint', 'participant_kit_items', 'participant_kit_items_participant_kit_unique'),
    ('constraint', 'tickets', 'tickets_pkey'),
    ('constraint', 'order_items', 'order_items_pkey')
)
select
  '15b_expected_constraints'::text as diagnostic,
  e.*,
  (pc.oid is not null) as exists_now,
  pg_get_constraintdef(pc.oid) as current_definition
from expected e
left join pg_namespace pn on pn.nspname = 'public'
left join pg_class rel on rel.relnamespace = pn.oid and rel.relname = e.table_name
left join pg_constraint pc on pc.conrelid = rel.oid and pc.conname = e.object_name
order by exists_now, e.table_name, e.object_name;

-- 16. Resumo final. SAFE_TO_APPLY exige schema completo e ausencia de casos
-- que tornem o backfill destrutivo, ambiguo ou incompatível com as unicidades.
with candidates as (
  select distinct pki.id as participant_kit_item_id, t.id as ticket_id, t.order_item_id
  from public.participant_kit_items pki
  join public.tickets t
    on t.event_id = pki.event_id
   and t.status <> 'cancelled'
  left join public.order_items oi on oi.id = t.order_item_id
  where oi.participant_id = pki.participant_id
     or t.participant_id = pki.participant_id
), candidate_counts as (
  select
    pki.id,
    pki.status,
    pki.kit_item_id,
    count(c.ticket_id)::integer as candidate_count,
    (array_agg(c.ticket_id order by c.ticket_id))[1] as ticket_id,
    (array_agg(c.order_item_id order by c.order_item_id)
      filter (where c.order_item_id is not null))[1] as order_item_id
  from public.participant_kit_items pki
  left join candidates c on c.participant_kit_item_id = pki.id
  group by pki.id, pki.status, pki.kit_item_id
), zero_assessment as (
  select cc.id,cc.status,
    exists(select 1 from public.orders o
      where o.participant_id=pki.participant_id and o.event_id=pki.event_id) has_order,
    import_data.valid_batch_count,
    p.ticket_category_id is not null and p.batch_id is not null
      and e.organization_id is not null has_required_registration_data,
    imported_order.order_count,
    coalesce(imported_order.payment_id,
      case when payment_data.payment_count=1 then payment_data.payment_id end) resolved_payment_id,
    resolved_payment.id is not null and resolved_payment.event_id=pki.event_id
      and resolved_payment.amount is not null and resolved_payment.final_amount is not null
      as has_valid_payment
  from candidate_counts cc
  join public.participant_kit_items pki on pki.id=cc.id
  left join public.participants p on p.id=pki.participant_id
  left join public.events e on e.id=pki.event_id
  left join lateral (
    select count(distinct ph.import_batch_id)::integer valid_batch_count,
      (array_agg(distinct ph.import_batch_id order by ph.import_batch_id))[1] import_batch_id
    from public.participation_history ph
    join public.import_batches ib on ib.id=ph.import_batch_id
      and ib.event_id=pki.event_id and ib.import_type='current_event_registrations'
    where ph.participant_id=pki.participant_id and ph.event_id=pki.event_id
      and ph.source='import' and ph.import_batch_id is not null
  ) import_data on true
  left join lateral (
    select count(*)::integer order_count,
      (array_agg(o.payment_id order by o.id))[1] payment_id
    from public.orders o
    where o.participant_id=pki.participant_id and o.event_id=pki.event_id
      and o.buyer_type='imported_holder' and o.user_id is null
      and o.import_batch_id=import_data.import_batch_id
  ) imported_order on true
  left join lateral (
    select count(*)::integer payment_count,
      (array_agg(pay.id order by pay.id))[1] payment_id
    from public.payments pay
    where pay.participant_id=pki.participant_id and pay.event_id=pki.event_id
  ) payment_data on true
  left join public.payments resolved_payment on resolved_payment.id=coalesce(
    imported_order.payment_id,
    case when payment_data.payment_count=1 then payment_data.payment_id end
  )
  where cc.candidate_count=0
), zero_classification as (
  select zero_assessment.*,
    (not has_order and valid_batch_count=0) unresolved_legacy_allowed,
    (valid_batch_count=1 and has_required_registration_data
      and order_count<=1 and (order_count=1 or not has_order)
      and has_valid_payment) imported_repairable
  from zero_assessment
), ticket_conflicts as (
  select ticket_id, kit_item_id
  from candidate_counts
  where candidate_count = 1
  group by ticket_id, kit_item_id
  having count(*) > 1
), order_item_conflicts as (
  select order_item_id, kit_item_id
  from candidate_counts
  where candidate_count = 1 and order_item_id is not null
  group by order_item_id, kit_item_id
  having count(*) > 1
), event_divergences as (
  select pki.id
  from public.participant_kit_items pki
  left join candidate_counts cc on cc.id = pki.id
  left join public.tickets t on t.id = cc.ticket_id and cc.candidate_count = 1
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.orders o on o.id = coalesce(t.order_id, oi.order_id)
  left join public.participants p on p.id = pki.participant_id
  left join public.event_kit_items eki on eki.id = pki.kit_item_id
  where pki.event_id is distinct from p.event_id
     or pki.event_id is distinct from eki.event_id
     or (cc.candidate_count = 1 and (
          pki.event_id is distinct from t.event_id
       or t.event_id is distinct from oi.event_id
       or t.event_id is distinct from o.event_id
     ))
), organization_divergences as (
  select pki.id
  from public.participant_kit_items pki
  left join candidate_counts cc on cc.id = pki.id
  left join public.events e on e.id = pki.event_id
  left join public.tickets t on t.id = cc.ticket_id and cc.candidate_count = 1
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.orders o on o.id = coalesce(t.order_id, oi.order_id)
  left join public.participants p on p.id = pki.participant_id
  left join public.event_kit_items eki on eki.id = pki.kit_item_id
  where pki.organization_id is distinct from e.organization_id
     or p.organization_id is distinct from e.organization_id
     or eki.organization_id is distinct from e.organization_id
     or (cc.candidate_count = 1 and (
          t.organization_id is distinct from e.organization_id
       or o.organization_id is distinct from e.organization_id
     ))
), expected_columns(table_name, column_name) as (
  values
    ('participant_kit_items', 'id'), ('participant_kit_items', 'participant_id'),
    ('participant_kit_items', 'event_id'), ('participant_kit_items', 'organization_id'),
    ('participant_kit_items', 'kit_item_id'), ('participant_kit_items', 'variant_data'),
    ('participant_kit_items', 'quantity'), ('participant_kit_items', 'status'),
    ('participant_kit_items', 'delivered_at'), ('participant_kit_items', 'created_at'),
    ('tickets', 'id'), ('tickets', 'order_id'), ('tickets', 'order_item_id'),
    ('tickets', 'participant_id'), ('tickets', 'event_id'),
    ('tickets', 'organization_id'), ('tickets', 'token'),
    ('tickets', 'status'), ('tickets', 'issued_at'),
    ('order_items', 'id'), ('order_items', 'order_id'),
    ('order_items', 'participant_id'), ('order_items', 'event_id'),
    ('order_items', 'status'), ('order_items', 'ownership_status'),
    ('order_items', 'shirt_type'), ('order_items', 'shirt_size'),
    ('orders', 'id'), ('orders', 'event_id'), ('orders', 'organization_id'),
    ('participants', 'id'), ('participants', 'event_id'),
    ('participants', 'organization_id'), ('event_kit_items', 'id'),
    ('event_kit_items', 'event_id'), ('event_kit_items', 'organization_id')
), missing_columns as (
  select ec.*
  from expected_columns ec
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = ec.table_name
   and c.column_name = ec.column_name
  where c.column_name is null
), expected_constraints(table_name, object_name) as (
  values
    ('participant_kit_items', 'participant_kit_items_pkey'),
    ('participant_kit_items', 'participant_kit_items_participant_id_fkey'),
    ('participant_kit_items', 'participant_kit_items_event_id_fkey'),
    ('participant_kit_items', 'participant_kit_items_kit_item_id_fkey'),
    ('participant_kit_items', 'participant_kit_items_quantity_positive'),
    ('participant_kit_items', 'participant_kit_items_participant_kit_unique'),
    ('tickets', 'tickets_pkey'),
    ('order_items', 'order_items_pkey')
), missing_constraints as (
  select ec.*
  from expected_constraints ec
  left join pg_namespace pn on pn.nspname = 'public'
  left join pg_class rel on rel.relnamespace = pn.oid and rel.relname = ec.table_name
  left join pg_constraint pc on pc.conrelid = rel.oid and pc.conname = ec.object_name
  where pc.oid is null
), required_current_signatures(schema_name,function_name,argument_types) as (
  values
    ('public','generate_order_number',''),
    ('public','user_can_access_organization','uuid, uuid'),
    ('public','current_user_has_permission','text'),
    ('public','normalize_text_for_match','text')
), historical_drift_signatures(schema_name,function_name,argument_types) as (
  values
    ('public','deliver_items_and_checkin','uuid, uuid')
), metrics as (
  select
    (select count(*) from candidate_counts where candidate_count = 0) as zero_candidates,
    (select count(*) from zero_classification where unresolved_legacy_allowed) as unresolved_legacy_allowed,
    (select count(*) from zero_classification where imported_repairable) as imported_repairable,
    (select count(*) from zero_classification
      where not unresolved_legacy_allowed and not imported_repairable) as unresolved_blocking,
    (select count(*) from candidate_counts where candidate_count > 1) as ambiguous_candidates,
    (select count(*) from candidate_counts where status = 'delivered' and candidate_count <> 1) as delivered_unresolved,
    (select count(*) from ticket_conflicts) as ticket_unique_conflicts,
    (select count(*) from order_item_conflicts) as order_item_unique_conflicts,
    (select count(*) from public.tickets where order_item_id is null) as tickets_without_order_item,
    (select count(*) from event_divergences) as event_divergences,
    (select count(*) from organization_divergences) as organization_divergences,
    (select count(*) from missing_columns) as missing_required_columns,
    (select count(*) from missing_constraints) as missing_required_constraints,
    (select count(*) from required_current_signatures e
      where not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=e.schema_name and p.proname=e.function_name
          and oidvectortypes(p.proargtypes)=e.argument_types
      )) as missing_required_current_signatures,
    (select count(*) from historical_drift_signatures e
      where not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=e.schema_name and p.proname=e.function_name
          and oidvectortypes(p.proargtypes)=e.argument_types
      )) as known_historical_drift
)
select
  '16_final_summary'::text as diagnostic,
  (
    unresolved_blocking = 0
    and ambiguous_candidates = 0
    and delivered_unresolved = 0
    and ticket_unique_conflicts = 0
    and order_item_unique_conflicts = 0
    and tickets_without_order_item = 0
    and event_divergences = 0
    and organization_divergences = 0
    and missing_required_columns = 0
    and missing_required_constraints = 0
    and missing_required_current_signatures = 0
  ) as "SAFE_TO_APPLY",
  (
    unresolved_blocking + ambiguous_candidates + delivered_unresolved
    + ticket_unique_conflicts + order_item_unique_conflicts
    + tickets_without_order_item + event_divergences
    + organization_divergences + missing_required_columns + missing_required_constraints
    + missing_required_current_signatures
  )::bigint as cases_requiring_review,
  array_remove(array[
    case when unresolved_legacy_allowed > 0 then format('%s legados sem ticket permitidos', unresolved_legacy_allowed) end,
    case when imported_repairable > 0 then format('%s vinculos importados regularizaveis pela migration 087', imported_repairable) end,
    case when known_historical_drift > 0 then format('%s assinaturas historicas conhecidas ausentes (nao bloqueante)', known_historical_drift) end
  ], null) as non_blocking_notes,
  array_remove(array[
    case when missing_required_columns > 0 then format('%s colunas obrigatorias ausentes', missing_required_columns) end,
    case when missing_required_constraints > 0 then format('%s constraints obrigatorias ausentes', missing_required_constraints) end,
    case when unresolved_blocking > 0 then format('%s vinculos sem ticket continuam bloqueantes', unresolved_blocking) end,
    case when ambiguous_candidates > 0 then format('%s vinculos com mais de um ticket candidato', ambiguous_candidates) end,
    case when delivered_unresolved > 0 then format('%s entregas ficariam sem ticket', delivered_unresolved) end,
    case when ticket_unique_conflicts > 0 then format('%s conflitos de ticket + item', ticket_unique_conflicts) end,
    case when order_item_unique_conflicts > 0 then format('%s conflitos de order_item + item', order_item_unique_conflicts) end,
    case when tickets_without_order_item > 0 then format('%s tickets sem order_item', tickets_without_order_item) end,
    case when event_divergences > 0 then format('%s divergencias de evento', event_divergences) end,
    case when organization_divergences > 0 then format('%s divergencias de organizacao', organization_divergences) end,
    case when missing_required_current_signatures > 0 then format('%s assinaturas atuais obrigatorias ausentes', missing_required_current_signatures) end
  ], null) as blocking_reasons,
  metrics.*
from metrics;

-- 17a. Dependencias atuais que a 087 usa e nao cria/substitui.
-- Somente a ausencia destas assinaturas bloqueia o preflight.
with required_current_signatures(schema_name,function_name,argument_types) as (
  values
    ('public','generate_order_number',''),
    ('public','user_can_access_organization','uuid, uuid'),
    ('public','current_user_has_permission','text'),
    ('public','normalize_text_for_match','text')
), installed as (
  select n.nspname schema_name,p.proname function_name,
    oidvectortypes(p.proargtypes) argument_types,
    pg_get_function_identity_arguments(p.oid) identity_arguments
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
), checked as (
  select e.schema_name,e.function_name,e.argument_types expected_argument_types,
    i.identity_arguments,
    (i.function_name is not null) signature_exists
  from required_current_signatures e left join installed i
    on i.schema_name=e.schema_name and i.function_name=e.function_name
   and i.argument_types=e.argument_types
)
select '17a_required_current_signatures'::text diagnostic,*
from checked
order by signature_exists,schema_name,function_name,expected_argument_types;

-- 17b. Drift historico conhecido. A API de dois argumentos foi substituida
-- pela API public.deliver_items_and_checkin(uuid), criada dentro da propria 087.
-- Sua ausencia e informativa e nunca bloqueia SAFE_TO_APPLY.
with historical_drift_signatures(schema_name,function_name,argument_types) as (
  values ('public','deliver_items_and_checkin','uuid, uuid')
), installed as (
  select n.nspname schema_name,p.proname function_name,
    oidvectortypes(p.proargtypes) argument_types,
    pg_get_function_identity_arguments(p.oid) identity_arguments
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
)
select '17b_historical_drift_signatures'::text diagnostic,
  e.schema_name,e.function_name,e.argument_types expected_argument_types,
  i.identity_arguments,(i.function_name is null) known_historical_drift,
  'nao bloqueante; substituida por public.deliver_items_and_checkin(uuid) na 087'::text resolution
from historical_drift_signatures e left join installed i
  on i.schema_name=e.schema_name and i.function_name=e.function_name
 and i.argument_types=e.argument_types
order by e.schema_name,e.function_name,e.argument_types;

do $$
declare v_missing text;
begin
  with required_current_signatures(schema_name,function_name,argument_types) as (
    values
      ('public','generate_order_number',''),
      ('public','user_can_access_organization','uuid, uuid'),
      ('public','current_user_has_permission','text'),
      ('public','normalize_text_for_match','text')
  )
  select string_agg(format('%I.%I(%s)',e.schema_name,e.function_name,e.argument_types),', ' order by e.function_name)
  into v_missing
  from required_current_signatures e
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=e.schema_name and p.proname=e.function_name
      and oidvectortypes(p.proargtypes)=e.argument_types
  );
  if v_missing is not null then
    raise exception 'Preflight 087: assinaturas atuais obrigatorias ausentes: %',v_missing;
  end if;
end;
$$;
