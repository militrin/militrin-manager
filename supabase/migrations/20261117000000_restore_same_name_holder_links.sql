-- Fase 8C: restaurar FKs cadastrais dos 4 SELF desvinculados pelo no-op de mesmo nome.
-- Escopo exclusivo: 1964, 2025, 2030, 2095.
-- 2052 permanece excluido (troca textual real, fora do escopo).
-- Nao altera holder_full_name, owner, intended_owner, pedido, pagamento, status, kit, pulseira.
-- Nao chama a RPC textual de titular.
-- 4/4 ou 0/4: uma unica transacao.

begin;

do $$
declare
  r record;
  v_ticket public.tickets%rowtype;
  v_item public.order_items%rowtype;
  v_participant public.participants%rowtype;
  v_contact public.registration_contacts%rowtype;
  v_updated integer;
  v_restored integer := 0;
  v_present integer;
begin
  select count(*) into v_present
  from public.tickets
  where id in (
    '8a994cbb-ef79-452a-8762-625c440c7411'::uuid,
    'b58defbb-df88-4ef0-9126-7be1dbeddf84'::uuid,
    'ce8f9a3a-7bfd-49c0-8a95-003299b870af'::uuid,
    '750dd73b-3d0f-4baf-b410-e820bad5a0c8'::uuid
  );
  if v_present = 0 then
    raise notice '8C skip: nenhum dos 4 tickets alvo existe neste banco';
    return;
  end if;
  if v_present is distinct from 4 then
    raise exception 'STOP 8C: esperava os 4 tickets alvo presentes, obteve %', v_present;
  end if;

  for r in
    select *
    from (
      values
        (
          '8a994cbb-ef79-452a-8762-625c440c7411'::uuid,
          '8f84b813-d43a-40d2-a1a4-0cdeb65038c8'::uuid,
          'Daniel Stein Sutel'::text,
          'd8277988-edf1-49b9-8289-47d280676066'::uuid,
          'e87416dd-aff5-42cf-8724-ad12d4cbe8f0'::uuid,
          '90784f42-3bd1-4941-a42e-8593abffefc7'::uuid
        ),
        (
          'b58defbb-df88-4ef0-9126-7be1dbeddf84'::uuid,
          'acf1d119-17c6-47cb-99cc-55f52273620a'::uuid,
          'Maria Julia Dalavechia'::text,
          'a3c79b1d-91dc-438a-af7d-9028a8ddafa0'::uuid,
          'bf7eb060-28c1-40d0-a753-a72784d36d39'::uuid,
          '1c75c05c-d7fe-47eb-8946-def632a3b230'::uuid
        ),
        (
          'ce8f9a3a-7bfd-49c0-8a95-003299b870af'::uuid,
          'f2fd377a-33f6-4dc7-bde7-0210d80a7c1d'::uuid,
          'Paulo Henrike da Rosa'::text,
          '1ca5ed2e-a77a-4c77-b6d3-d9ed2cf33c35'::uuid,
          'b174c706-aed1-4af0-b4e9-8c80129aa3a3'::uuid,
          '03048428-bd6d-4871-9182-4f0efc73d429'::uuid
        ),
        (
          '750dd73b-3d0f-4baf-b410-e820bad5a0c8'::uuid,
          'bd54a4a6-141a-4cb7-bd3f-3c36e513476c'::uuid,
          'Bruna Sell'::text,
          'c5db9d00-a358-4bff-a6ac-abaec9611817'::uuid,
          'a0d04017-a68c-46fc-8686-ef75dc14e0f1'::uuid,
          'e90fa59c-0fbb-4290-a3f4-abce82d20eb8'::uuid
        )
    ) as t(ticket_id, order_item_id, holder_name, owner_user_id, participant_id, contact_id)
  loop
    select * into v_ticket from public.tickets where id = r.ticket_id for update;
    if not found then
      raise exception 'STOP 8C: ticket % nao encontrado', r.ticket_id;
    end if;
    if v_ticket.order_item_id is distinct from r.order_item_id then
      raise exception 'STOP 8C: order_item_id divergente em %', r.ticket_id;
    end if;
    if v_ticket.status not in ('active', 'used') then
      raise exception 'STOP 8C: status invalido em %', r.ticket_id;
    end if;
    if v_ticket.owner_user_id is distinct from r.owner_user_id then
      raise exception 'STOP 8C: owner divergente em %', r.ticket_id;
    end if;
    if v_ticket.intended_owner_contact_id is not null then
      raise exception 'STOP 8C: intended_owner divergente em %', r.ticket_id;
    end if;
    if v_ticket.participant_id is not null then
      raise exception 'STOP 8C: tickets.participant_id nao esta null em %', r.ticket_id;
    end if;

    select * into v_item from public.order_items where id = r.order_item_id for update;
    if not found then
      raise exception 'STOP 8C: order_item % nao encontrado', r.order_item_id;
    end if;
    if nullif(trim(coalesce(v_item.holder_full_name, '')), '') is distinct from r.holder_name then
      raise exception 'STOP 8C: holder textual divergente em %', r.ticket_id;
    end if;
    if v_item.participant_id is not null then
      raise exception 'STOP 8C: order_items.participant_id nao esta null em %', r.ticket_id;
    end if;
    if v_item.registration_contact_id is not null then
      raise exception 'STOP 8C: order_items.registration_contact_id nao esta null em %', r.ticket_id;
    end if;

    select * into v_participant from public.participants where id = r.participant_id;
    if not found then
      raise exception 'STOP 8C: participant historico % nao existe', r.participant_id;
    end if;
    if v_participant.event_id is distinct from v_ticket.event_id then
      raise exception 'STOP 8C: participant % fora do evento do ticket %', r.participant_id, r.ticket_id;
    end if;
    if v_participant.registration_contact_id is distinct from r.contact_id then
      raise exception 'STOP 8C: participant % nao aponta para contact historico', r.participant_id;
    end if;

    select * into v_contact from public.registration_contacts where id = r.contact_id;
    if not found then
      raise exception 'STOP 8C: registration_contact historico % nao existe', r.contact_id;
    end if;

    if exists (
      select 1
      from public.tickets t
      join public.order_items oi on oi.id = t.order_item_id
      where t.event_id = v_ticket.event_id
        and t.id is distinct from v_ticket.id
        and t.status not in ('cancelled', 'canceled', 'void', 'voided')
        and (
          t.participant_id is not distinct from r.participant_id
          or oi.participant_id is not distinct from r.participant_id
          or oi.registration_contact_id is not distinct from r.contact_id
        )
    ) then
      raise exception 'STOP 8C: conflito de unicidade para ticket %', r.ticket_id;
    end if;

    update public.order_items
    set
      participant_id = r.participant_id,
      registration_contact_id = r.contact_id
    where id = r.order_item_id
      and participant_id is null
      and registration_contact_id is null
      and nullif(trim(coalesce(holder_full_name, '')), '') is not distinct from r.holder_name;
    get diagnostics v_updated = row_count;
    if v_updated is distinct from 1 then
      raise exception 'STOP 8C: UPDATE order_items nao atingiu 1 linha em %', r.ticket_id;
    end if;

    update public.tickets
    set participant_id = r.participant_id
    where id = r.ticket_id
      and participant_id is null
      and owner_user_id is not distinct from r.owner_user_id
      and order_item_id is not distinct from r.order_item_id
      and status in ('active', 'used');
    get diagnostics v_updated = row_count;
    if v_updated is distinct from 1 then
      raise exception 'STOP 8C: UPDATE tickets nao atingiu 1 linha em %', r.ticket_id;
    end if;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'holder_links_restored',
      'tickets',
      r.ticket_id,
      v_ticket.event_id,
      jsonb_build_object(
        'ticket_id', r.ticket_id,
        'order_item_id', r.order_item_id,
        'restored_participant_id', r.participant_id,
        'restored_registration_contact_id', r.contact_id,
        'reason_code', 'data_regularization',
        'source', 'same_name_holder_noop_repair',
        'message', 'restauracao de vinculo cadastral removido por same-name holder no-op',
        'holder_full_name', r.holder_name,
        'owner_user_id', r.owner_user_id
      )
    );

    v_restored := v_restored + 1;
  end loop;

  if v_restored is distinct from 4 then
    raise exception 'STOP 8C: esperava 4 restauracoes, obteve %', v_restored;
  end if;
end $$;

commit;
