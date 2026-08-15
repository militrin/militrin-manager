-- 084_atomic_deliver_items_and_checkin.sql
-- Garante entrega e check-in na mesma transacao.

begin;

create or replace function public.deliver_items_and_checkin(
  p_participant_id uuid,
  p_ticket_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_checkin_ok boolean;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para entregar itens.';
  end if;

  if not public.current_user_has_permission('checkin.scan') then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  if not exists (
    select 1
    from public.tickets t
    where t.id = p_ticket_id
      and t.participant_id = p_participant_id
    for update
  ) then
    raise exception 'Ingresso e participante nao correspondem.';
  end if;

  perform public.deliver_participant_full_kit(p_participant_id);
  select public.checkin_ticket_entry(p_ticket_id) into v_checkin_ok;

  if v_checkin_ok is distinct from true then
    raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.';
  end if;

  return true;
end;
$$;

revoke all on function public.deliver_items_and_checkin(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.deliver_items_and_checkin(uuid, uuid)
  to authenticated;

commit;
