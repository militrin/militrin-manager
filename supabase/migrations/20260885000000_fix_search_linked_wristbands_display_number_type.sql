-- Corrige o erro "structure of query does not match function result type" em
-- public.search_linked_wristbands (criada na migration 84, aplicada).
--
-- CAUSA-RAIZ CONFIRMADA (auditoria de schema, nao suposicao): a migration 84
-- declarou "order_display_number integer" no RETURNS TABLE, mas a coluna real
-- e public.orders.display_number BIGINT -- adicionada como bigint em
-- 20260882000000_public_display_numbers.sql:5 ("alter table public.orders
-- add column if not exists display_number bigint;") e nunca mudou de tipo
-- desde entao. RETURN QUERY exige que o tipo de cada coluna selecionada bata
-- EXATAMENTE com o RETURNS TABLE (bigint -> integer nao e um narrowing
-- implicito aceito) -- daí o erro.
--
-- Todas as outras colunas do RETURNS TABLE foram reauditadas contra o DDL
-- real (nao contra o formato solto do OpenAPI) e batem exatamente:
--   participant_wristbands.id/code/status/linked_at/linked_by/ticket_id ->
--     uuid/text/text/timestamptz/uuid/uuid (20260815001914_remote_schema.sql:15697-15713)
--   tickets.status/used_at/order_id -> text/timestamptz/uuid (mesmo arquivo:16070-16087)
--   orders.order_number/user_id -> text/uuid (mesmo arquivo:14892-14913)
--   order_items.item_position -> integer, nao bigint (mesmo arquivo:14877)
--   participants.full_name/cpf -> text/text (mesmo arquivo:15720+)
--   registration_contacts.public_pin -> text (mesmo arquivo:15863-15877)
--   events.name -> text
--   count(*) over () -> bigint (agregado do Postgres, sempre bigint)
-- Unica divergencia real: order_display_number.
--
-- CREATE OR REPLACE nao é suficiente quando o RETURNS TABLE muda o tipo de
-- uma coluna -- Postgres exige DROP FUNCTION antes (mesmo padrao ja usado em
-- 20260848000000_wristband_requirement_and_reason_coded_undo.sql pra
-- mudanca de assinatura). Assinatura de parametros (uuid, text, integer,
-- integer) nao muda, so o tipo de retorno.
begin;

drop function if exists public.search_linked_wristbands(uuid, text, integer, integer);

create or replace function public.search_linked_wristbands(
  p_event_id uuid,
  p_query text default null,
  p_limit integer default 30,
  p_offset integer default 0
) returns table(
  wristband_id uuid,
  code text,
  linked_at timestamptz,
  linked_by uuid,
  ticket_id uuid,
  ticket_status text,
  used_at timestamptz,
  order_id uuid,
  order_display_number bigint,
  order_number text,
  item_position integer,
  order_user_id uuid,
  participant_full_name text,
  participant_cpf text,
  registration_contact_pin text,
  event_name text,
  total_count bigint
) language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_organization_id uuid;
  v_query text := nullif(trim(coalesce(p_query, '')), '');
  v_query_digits text := nullif(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g'), '');
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select e.organization_id into v_organization_id from public.events e where e.id = p_event_id;
  if v_organization_id is null then raise exception 'Evento nao encontrado.'; end if;

  if not public.user_can_access_organization(v_actor, v_organization_id)
    or not (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor, 'wristbands.view'))
  then
    raise exception 'Usuario sem permissao para consultar pulseiras vinculadas.';
  end if;

  return query
  with matches as (
    select
      pw.id as wristband_id, pw.code, pw.linked_at, pw.linked_by, pw.ticket_id,
      t.status as ticket_status, t.used_at, t.order_id,
      o.display_number as order_display_number, o.order_number, oi.item_position, o.user_id as order_user_id,
      coalesce(nullif(trim(p.full_name), ''), nullif(trim(oi.holder_full_name), ''), 'Titular não definido') as participant_full_name,
      p.cpf as participant_cpf,
      rc.public_pin as registration_contact_pin,
      ev.name as event_name
    from public.participant_wristbands pw
    join public.tickets t on t.id = pw.ticket_id
    left join public.order_items oi on oi.id = t.order_item_id
    left join public.orders o on o.id = t.order_id
    left join public.participants p on p.id = coalesce(oi.participant_id, pw.participant_id, t.participant_id)
    left join public.registration_contacts rc on rc.id = p.registration_contact_id
    join public.events ev on ev.id = pw.event_id
    where pw.status = 'active'
      and pw.organization_id = v_organization_id
      and pw.event_id = p_event_id
      and (
        v_query is null
        or pw.code ilike '%' || v_query || '%'
        or p.full_name ilike '%' || v_query || '%'
        or oi.holder_full_name ilike '%' || v_query || '%'
        or (v_query_digits is not null and regexp_replace(coalesce(p.cpf, ''), '[^0-9]', '', 'g') ilike '%' || v_query_digits || '%')
        or (v_query_digits is not null and rc.public_pin ilike '%' || v_query_digits || '%')
        or rc.public_pin ilike '%' || v_query || '%'
      )
  ),
  counted as (
    select *, count(*) over () as total_count from matches
  )
  select
    counted.wristband_id, counted.code, counted.linked_at, counted.linked_by, counted.ticket_id,
    counted.ticket_status, counted.used_at, counted.order_id, counted.order_display_number, counted.order_number,
    counted.item_position, counted.order_user_id, counted.participant_full_name, counted.participant_cpf,
    counted.registration_contact_pin, counted.event_name, counted.total_count
  from counted
  order by counted.linked_at desc
  limit v_limit offset v_offset;
end;
$$;

revoke all on function public.search_linked_wristbands(uuid, text, integer, integer) from public, anon;
grant execute on function public.search_linked_wristbands(uuid, text, integer, integer) to authenticated, service_role;

commit;
