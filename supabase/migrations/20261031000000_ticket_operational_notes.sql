-- Observacoes do ingresso (ticket-first), aditivas.
-- participants.notes permanece anotacao cadastral da projecao no evento.
-- tickets.operational_notes e anotacao operacional daquele ingresso.

begin;

alter table public.tickets
  add column if not exists operational_notes text;

comment on column public.tickets.operational_notes is
  'Anotacao operacional deste ingresso neste evento. Independente de Cadastro/participant.';

comment on column public.participants.notes is
  'Anotacao cadastral deste participante neste evento. Titular textual sem Cadastro nao possui esta nota.';

-- Preserva notas historicas usadas na ficha do ingresso (antes misturadas em participants.notes).
update public.tickets t
set operational_notes = nullif(trim(p.notes), '')
from public.order_items oi, public.participants p
where oi.id = t.order_item_id
  and p.id = coalesce(t.participant_id, oi.participant_id)
  and t.operational_notes is null
  and nullif(trim(coalesce(p.notes, '')), '') is not null;

create or replace function public.update_ticket_operational_notes(p_ticket_id uuid, p_notes text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_ticket_id is null then raise exception 'Ingresso invalido.'; end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if not public.user_can_access_organization(v_actor, v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;
  if not (
    public.is_active_owner(v_actor)
    or public.resolve_user_permission(v_actor, 'participants.edit_basic')
  ) then
    raise exception 'Sem acesso a anotacao.';
  end if;

  update public.tickets
  set operational_notes = v_notes
  where id = v_ticket.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'ticket_notes_updated',
    'tickets',
    v_ticket.id,
    v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'ticket_id', v_ticket.id,
      'notes', v_notes
    )
  );

  return true;
end;
$$;

comment on function public.update_ticket_operational_notes(uuid, text) is
  'Atualiza a observacao operacional do ingresso. Nao exige participant_id nem Cadastro.';

revoke all on function public.update_ticket_operational_notes(uuid, text) from public, anon;
grant execute on function public.update_ticket_operational_notes(uuid, text) to authenticated, service_role;

commit;
