-- Checkout futuro: titular nomeado e somente holder_full_name.
-- Nao cria Cadastro, participant nem Auth. Nao faz matching por CPF/e-mail/telefone.
-- Nao transfere propriedade. Nao apaga dados historicos.
-- Nao altera materialize_self_checkout_holder alem de preencher o nome
-- textual do comprador no item "para mim".

begin;

-- ============================================================
-- 1. Compra para si: nome textual a partir da conta, sem duplicar identidade
-- ============================================================

create or replace function public.materialize_self_checkout_holder(
  p_order_id uuid,p_assign_first_to_buyer boolean,p_buyer_cpf text,p_buyer_full_name text,
  p_buyer_birth_date date,p_buyer_gender text,p_buyer_phone text,p_buyer_email text,p_buyer_city text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_contact public.registration_contacts%rowtype; v_cpf text:=regexp_replace(coalesce(p_buyer_cpf,''),'\D','','g');
  v_ticket_id uuid;
  v_buyer_name text:=nullif(trim(coalesce(p_buyer_full_name,'')),'');
begin
  if not coalesce(p_assign_first_to_buyer,false) then return; end if;
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;

  select * into v_order from public.orders where id=p_order_id and user_id=v_actor for update;
  if not found then raise exception 'Pedido do checkout nao encontrado.'; end if;

  select * into v_item from public.order_items where order_id=v_order.id and item_position=1
    and ownership_status='assigned' for update;
  if not found then return; end if;

  -- Ticket-first: o ingresso "para mim" recebe o nome da conta mesmo se o
  -- Cadastro do comprador ja existir. Nao cria identidade duplicada.
  if v_buyer_name is not null and nullif(trim(coalesce(v_item.holder_full_name,'')),'') is null then
    update public.order_items
    set holder_full_name=v_buyer_name, updated_at=now()
    where id=v_item.id;
    v_item.holder_full_name:=v_buyer_name;
  end if;

  if v_item.registration_contact_id is not null then return; end if;
  if length(v_cpf)<>11 then raise exception 'CPF do comprador invalido para titularidade automatica.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.organization_id::text||':cpf:'||v_cpf,0));

  select * into v_contact from public.registration_contacts
    where organization_id=v_order.organization_id and cpf=v_cpf for update;
  if not found then
    insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city,created_by)
    values(v_order.organization_id,trim(p_buyer_full_name),v_cpf,p_buyer_birth_date,
      nullif(trim(coalesce(p_buyer_gender,'')),''),regexp_replace(coalesce(p_buyer_phone,''),'\D','','g'),
      lower(trim(coalesce(p_buyer_email,''))),nullif(trim(coalesce(p_buyer_city,'')),''),v_actor)
    returning * into v_contact;
  end if;

  select id into v_ticket_id from public.tickets where order_item_id=v_item.id;

  perform public.assert_ticket_holder_contact_available(v_ticket_id,v_order.event_id,v_contact.id);

  update public.order_items set registration_contact_id=v_contact.id,
    holder_full_name=coalesce(nullif(trim(coalesce(v_item.holder_full_name,'')),''), v_contact.full_name),
    updated_at=now() where id=v_item.id;
  if v_item.participant_id is not null then
    update public.participants set registration_contact_id=v_contact.id
      where id=v_item.participant_id and registration_contact_id is null;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('self_ticket_holder_materialized','order_items',v_item.id,v_order.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'order_id',v_order.id,'order_item_id',v_item.id,'registration_contact_id',v_contact.id));
end; $$;

revoke all on function public.materialize_self_checkout_holder(uuid,boolean,text,text,date,text,text,text,text)
  from public,anon,authenticated;

-- ============================================================
-- 2. Compra para terceiro: somente nome textual
-- ============================================================

create or replace function public.materialize_named_checkout_holders(p_order_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_ticket public.tickets%rowtype;
  v_payload jsonb;
  v_index integer;
  v_mode text;
  v_name text;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_actor for update;
  if not found then raise exception 'Pedido do checkout nao encontrado.'; end if;

  for v_index in 1..jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) loop
    v_payload := p_items -> (v_index - 1);
    v_mode := lower(trim(coalesce(v_payload->>'ownership_mode', '')));
    if v_mode <> 'named' then continue; end if;

    select * into v_item from public.order_items where order_id = v_order.id and item_position = v_index for update;
    if not found then raise exception 'Item nomeado do checkout nao encontrado na posicao %.', v_index; end if;

    v_name := nullif(trim(coalesce(v_payload->>'holder_full_name', v_item.holder_full_name, '')), '');
    if v_name is not null and char_length(v_name) > 200 then
      raise exception 'Nome do titular excede o limite.';
    end if;

    select * into v_ticket from public.tickets where order_item_id = v_item.id for update;
    if not found then v_ticket.id := null; v_ticket.owner_user_id := null; end if;

    -- Titular textual: ignora CPF, e-mail, telefone e holder_registration_contact_id.
    -- Nao cria Cadastro, participant, Auth, claim nem transferencia.
    update public.order_items
    set
      participant_id = null,
      registration_contact_id = null,
      holder_full_name = v_name,
      ownership_status = case when v_name is null then 'unassigned' else 'assigned' end,
      updated_at = now()
    where id = v_item.id;

    if v_ticket.id is not null then
      update public.tickets
      set participant_id = null
      where id = v_ticket.id
        and owner_user_id is not distinct from v_ticket.owner_user_id;
    end if;

    update public.participant_data_issues
    set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where order_item_id = v_item.id and status = 'open' and issue_type = 'insufficient_named_holder_identity';

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'named_ticket_holder_textual',
      case when v_ticket.id is null then 'order_items' else 'tickets' end,
      coalesce(v_ticket.id, v_item.id),
      v_item.event_id,
      jsonb_build_object(
        'actor_user_id', v_actor,
        'order_id', v_order.id,
        'order_item_id', v_item.id,
        'ticket_id', v_ticket.id,
        'owner_user_id', v_ticket.owner_user_id,
        'holder_full_name_snapshot', v_name,
        'ignored_identity_fields', true
      )
    );
  end loop;
end;
$$;

comment on function public.materialize_named_checkout_holders(uuid, jsonb) is
  'Checkout nomeado grava somente holder_full_name. Nao materializa Cadastro/participant.';

revoke all on function public.materialize_named_checkout_holders(uuid, jsonb)
  from public, anon, authenticated;

commit;
