-- Restaura o fluxo de desvincular pulseira pro papel Operacional (auditoria
-- em produção confirmou: wristbands.view + wristbands.link foram concedidos
-- ao preset 'operational' em 20260879000000_consolidate_admin_roles.sql, mas
-- wristbands.unlink/wristbands.replace nunca foram -- nem os papeis legados
-- que ele substituiu (checkin/kit_delivery/support) tinham essas duas. Owner/
-- Administrator sempre bypassaram via resolve_user_permission, entao o botao
-- "Desvincular pulseira" em ExpandedTicketDetails.tsx (ja existe, condicionado
-- a capabilities.canUnlinkWristband) nunca teve bug de codigo -- so faltava a
-- permissao pros 3 operadores reais da organizacao com papel Operacional.
-- Nao altera unlink_wristband_from_ticket/link_wristband_to_ticket/
-- replace_wristband_for_ticket (RPCs canonicas, ja existem e ja sao usadas
-- pelo frontend via unlinkWristbandAction/linkWristbandAction/
-- replaceWristbandAction em operacoes/actions.ts -- reaproveitadas aqui, sem
-- DELETE direto no frontend).
begin;

insert into public.admin_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.admin_roles role
join public.admin_permissions permission on permission.code in ('wristbands.unlink', 'wristbands.replace')
where role.code = 'operational'
on conflict (role_id, permission_id) do nothing;

insert into public.admin_role_permissions_system_default (role_id, permission_id)
select arp.role_id, arp.permission_id
from public.admin_role_permissions arp
join public.admin_roles r on r.id = arp.role_id
join public.admin_permissions p on p.id = arp.permission_id
where p.code in ('wristbands.unlink', 'wristbands.replace') and r.code = 'operational'
on conflict do nothing;

-- Lista de pulseiras vinculadas ATUALMENTE (status='active'), com busca
-- server-side por nome/CPF/PIN/codigo -- pedido explicito do usuario pra nao
-- carregar tudo no client. Titular vem direto de
-- participant_wristbands.participant_id (coluna ja existe na linha, ver
-- schema real) -- nao depende de order_items/comprador pra aparecer, entao
-- cortesia/emissao administrativa/sem comprador nunca ficam de fora (mesma
-- regra de "ingresso operavel" ja validada na auditoria da Central de
-- Operacoes). Comprador e resolvido depois, em TypeScript, via
-- get_operation_buyers (RPC ja existente) -- esta funcao so devolve
-- order_id/user_id pra isso, sem duplicar aquela logica aqui.
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
  order_display_number integer,
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
