-- P0: "Emitir sem titular" para uma conta conhecida deve manter o owner.
-- Holder continua NULL. Minha Conta lista por tickets.owner_user_id.
-- Nao confirma PIX. Nao cria Asaas. Nao emite ingresso extra.
-- Backfill restrito aos 2 tickets orfaos emitidos para o cadastro do Leonardo.

begin;

create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid, p_event_id uuid, p_ticket_category_id uuid, p_batch_id uuid, p_quantity integer,
  p_pricing_gender text, p_shirt_type text, p_shirt_size text, p_payment_method text, p_notes text default null,
  p_assign_holder boolean default true
) returns table(ticket_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record;
  v_extra record;
  v_index integer;
  v_owner_user_id uuid;
  v_issue_reason text := lower(trim(coalesce(p_payment_method, '')));
  v_financial_method constant text := 'courtesy';
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_issue_reason not in ('courtesy', 'system_failure', 'administrative_correction', 'other') then
    raise exception 'Motivo de emissao manual invalido.';
  end if;
  if v_issue_reason = 'other' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Descreva o motivo da emissao manual.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Quantidade deve estar entre 1 e 20.';
  end if;
  select organization_id into v_event_organization_id from public.events where id = p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event_organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select * into v_contact from public.registration_contacts
  where id = p_registration_contact_id and organization_id = v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;
  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);

  if coalesce(p_assign_holder, true) then
    perform public.assert_ticket_holder_contact_available(null, p_event_id, v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id, p_ticket_category_id, p_batch_id, v_contact.full_name, v_contact.cpf, v_contact.birth_date,
      p_pricing_gender, v_contact.phone, v_contact.email, v_contact.city, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.participants
    set registration_contact_id = v_contact.id,
        user_id = case when user_id is null then v_contact.user_id else user_id end
    where id = v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items
    set registration_contact_id = v_contact.id,
        intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    update public.tickets
    set intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_first.ticket_id;
    if v_contact.user_id is not null then
      perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
    end if;
    v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);
    update public.tickets
    set owner_user_id = v_owner_user_id
    where id = v_first.ticket_id
      and owner_user_id is null
      and v_owner_user_id is not null;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_first.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_first.ticket_id, v_first.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao administrativa para Pessoa com conta vinculada.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_first.ticket_id);
    ticket_id := v_first.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_first.order_id,
      'order_item_id', v_first.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', true, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id));
    return next;
    v_index := 2;
  else
    v_index := 1;
  end if;

  v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id, p_ticket_category_id, p_batch_id, p_pricing_gender, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.order_items
    set intended_owner_contact_id = v_contact.id
    where id = v_extra.order_item_id
      and participant_id is null
      and coalesce(ownership_status, 'unassigned') = 'unassigned';
    update public.tickets
    set
      owner_user_id = v_owner_user_id,
      intended_owner_contact_id = v_contact.id
    where id = v_extra.ticket_id
      and participant_id is null;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_extra.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_extra.ticket_id, v_extra.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao sem titular para conta de destino.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_extra.ticket_id);
    ticket_id := v_extra.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_extra.order_id,
      'order_item_id', v_extra.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', false, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id, 'holder_assigned', false));
    return next;
  end loop;
end;
$$;

revoke all on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  to authenticated;

with repaired as (
  update public.tickets t
  set
    owner_user_id = 'cee47839-827b-4c57-8778-490b1f7c5faa',
    intended_owner_contact_id = 'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5'
  where t.id in (
    'ad6f3bcd-caee-4b47-8d48-0dce27d04672',
    'e4fb3203-af43-4d1d-b6e0-94bfcebc326c'
  )
    and t.event_id = '17e8ecdd-5acf-4048-bc52-b47817d42e23'
    and t.status = 'active'
    and t.owner_user_id is null
    and t.intended_owner_contact_id is null
    and t.participant_id is null
  returning t.id, t.order_id, t.event_id, t.organization_id, t.order_item_id
),
items as (
  update public.order_items i
  set intended_owner_contact_id = 'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5'
  from repaired
  where i.id = repaired.order_item_id
    and i.participant_id is null
    and coalesce(i.ownership_status, 'unassigned') = 'unassigned'
    and i.holder_full_name is null
    and i.intended_owner_contact_id is null
  returning i.id
),
history as (
  insert into public.ticket_owner_history (
    ticket_id, order_id, event_id, organization_id, operation,
    previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
  )
  select
    repaired.id,
    repaired.order_id,
    repaired.event_id,
    coalesce(repaired.organization_id, '8d650d17-a190-417d-9ea6-a21e86fb9ac5'),
    'owner_assigned',
    null,
    'cee47839-827b-4c57-8778-490b1f7c5faa',
    'e8f5777b-3ed1-409d-b3f1-71724be5a09e',
    'data_regularization',
    'Reparo P0: emissao sem titular para conta conhecida havia zerado owner_user_id.'
  from repaired
  where not exists (
    select 1 from public.ticket_owner_history h where h.ticket_id = repaired.id
  )
  returning ticket_id
)
insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
select
  'unassigned_manual_ticket_owner_repaired',
  'tickets',
  repaired.id,
  repaired.event_id,
  jsonb_build_object(
    'order_id', repaired.order_id,
    'order_item_id', repaired.order_item_id,
    'owner_user_id', 'cee47839-827b-4c57-8778-490b1f7c5faa',
    'intended_owner_contact_id', 'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5',
    'holder_assigned', false,
    'reason', 'emit_without_holder_kept_destination_owner'
  )
from repaired;

commit;
