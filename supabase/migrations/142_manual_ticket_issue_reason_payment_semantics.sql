-- 142_manual_ticket_issue_reason_payment_semantics.sql
-- Separa motivo administrativo do metodo financeiro da emissao manual.

begin;

create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid,p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_quantity integer,
  p_pricing_gender text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null,
  p_assign_holder boolean default true
) returns table(ticket_id uuid) language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record; v_extra record; v_index integer;
  v_issue_reason text:=lower(trim(coalesce(p_payment_method,'')));
  v_financial_method constant text:='courtesy';
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_issue_reason not in('courtesy','system_failure','administrative_correction','other') then
    raise exception 'Motivo de emissao manual invalido.';
  end if;
  if v_issue_reason='other' and nullif(trim(coalesce(p_notes,'')),'') is null then
    raise exception 'Descreva o motivo da emissao manual.';
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>20 then raise exception 'Quantidade deve estar entre 1 e 20.'; end if;

  select organization_id into v_event_organization_id from public.events where id=p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_event_organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select * into v_contact from public.registration_contacts
  where id=p_registration_contact_id and organization_id=v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;

  if coalesce(p_assign_holder,true) then
    perform public.assert_ticket_holder_contact_available(null,p_event_id,v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id,p_ticket_category_id,p_batch_id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,
      p_pricing_gender,v_contact.phone,v_contact.email,v_contact.city,p_shirt_type,p_shirt_size,
      v_financial_method,p_notes);
    update public.participants set registration_contact_id=v_contact.id where id=v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items set registration_contact_id=v_contact.id where id=v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    ticket_id:=v_first.ticket_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('manual_ticket_issued','tickets',ticket_id,p_event_id,jsonb_build_object(
      'actor_user_id',v_actor,'registration_contact_id',v_contact.id,'order_id',v_first.order_id,
      'order_item_id',v_first.order_item_id,'issue_reason',v_issue_reason,'reason_text',nullif(trim(coalesce(p_notes,'')),''),
      'payment_method',v_financial_method,'assign_holder',true,'organization_id',v_event_organization_id));
    return next; v_index:=2;
  else
    v_index:=1;
  end if;

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id,p_ticket_category_id,p_batch_id,p_pricing_gender,p_shirt_type,p_shirt_size,
      v_financial_method,p_notes);
    ticket_id:=v_extra.ticket_id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('manual_ticket_issued','tickets',ticket_id,p_event_id,jsonb_build_object(
      'actor_user_id',v_actor,'registration_contact_id',v_contact.id,'order_id',v_extra.order_id,
      'order_item_id',v_extra.order_item_id,'issue_reason',v_issue_reason,'reason_text',nullif(trim(coalesce(p_notes,'')),''),
      'payment_method',v_financial_method,'assign_holder',false,'organization_id',v_event_organization_id));
    return next;
  end loop;
end; $$;

revoke all on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,boolean)
  to authenticated;

commit;
