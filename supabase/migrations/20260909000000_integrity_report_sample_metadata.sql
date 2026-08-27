begin;

-- UX da Central de Integridade Operacional (P0): quando so 1 registro esta
-- afetado, a Central mostra um botao de acao direto no card resumido (sem
-- abrir o drawer) -- mas esse card so tinha titulo/descricao genericos do
-- detector, nunca o "quem/qual" (ex.: "Pedido #001078 · Douglas Hobold ·
-- Militrin · Open Bar"). Essa informacao ja existia por linha (metadata
-- jsonb, ver integrity_issue_row) e ja era exposta pra o drawer via
-- get_operational_integrity_issue_entities -- so faltava propagar uma
-- amostra pro card resumido, do mesmo jeito que action_label/action_href/
-- sample_entity_id ja fazem (array_agg(...)[1]).
--
-- RETURNS TABLE muda (nova coluna sample_metadata) -- Postgres nao permite
-- CREATE OR REPLACE mudar o tipo de retorno de uma funcao, entao precisa
-- dropar antes.
drop function if exists public.get_operational_integrity_report(uuid);

create function public.get_operational_integrity_report(p_event_id uuid default null)
returns table(
  code text, severity text, domain text, title text, description text, event_id uuid,
  affected_count integer, action_label text, action_href text, sample_entity_type text, sample_entity_id uuid,
  sample_metadata jsonb
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('integrity.view') then
    raise exception 'Sem permissao para ver integridade operacional.';
  end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if p_event_id is not null and not exists (select 1 from public.events e where e.id = p_event_id and e.organization_id = v_org) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;

  return query
  with raw as (
    select * from public.detect_integrity_named_without_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_duplicate_active_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_legacy_holder_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_paid_order_without_ticket(v_org, p_event_id)
    union all select * from public.detect_integrity_ticket_without_order_item(v_org, p_event_id)
    union all select * from public.detect_integrity_single_ticket_price_unconfirmed(v_org, p_event_id)
    union all select * from public.detect_integrity_no_purchasable_category(v_org, p_event_id)
    union all select * from public.detect_integrity_category_event_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_missing_shirt_variant(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_pending_kit(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_inventory_overdelivered(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_checkin(v_org, p_event_id)
    union all select * from public.detect_integrity_open_blocking_data_issue(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_kit_without_variants(v_org, p_event_id)
  ),
  grouped as (
    select
      r.code, r.severity, r.domain, (array_agg(r.title))[1] as title, (array_agg(r.description))[1] as description,
      r.event_id, count(*)::integer as affected_count,
      (array_agg(r.action_label))[1] as action_label, (array_agg(r.action_href))[1] as action_href,
      (array_agg(r.entity_type))[1] as sample_entity_type, (array_agg(r.entity_id))[1] as sample_entity_id,
      (array_agg(r.metadata))[1] as sample_metadata
    from raw r
    group by r.code, r.severity, r.domain, r.event_id
  )
  select g.code, g.severity, g.domain, g.title, g.description, g.event_id, g.affected_count,
    g.action_label, g.action_href, g.sample_entity_type, g.sample_entity_id, g.sample_metadata
  from grouped g
  order by (case g.severity when 'critical' then 0 when 'attention' then 1 when 'warning' then 2 else 3 end), g.domain, g.code;
end; $$;

revoke all on function public.get_operational_integrity_report(uuid) from public, anon;
grant execute on function public.get_operational_integrity_report(uuid) to authenticated;

commit;
