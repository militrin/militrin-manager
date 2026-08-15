-- Materializa titulares nomeados do checkout multi na arquitetura contact-first.
-- O snapshot textual nunca e usado sozinho para resolver ou criar identidade.
begin;

alter function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) rename to create_multi_ticket_order_checkout_inventory_legacy;

revoke all on function public.create_multi_ticket_order_checkout_inventory_legacy(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) from public,anon,authenticated;

create or replace function public.materialize_named_checkout_holders(p_order_id uuid,p_items jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_order public.orders%rowtype; v_item public.order_items%rowtype;
  v_ticket public.tickets%rowtype; v_contact public.registration_contacts%rowtype;
  v_participant public.participants%rowtype; v_payload jsonb; v_index integer;
  v_mode text; v_name text; v_cpf text; v_email text; v_phone text; v_contact_id uuid;
  v_contact_count integer; v_participant_count integer; v_has_reliable_identity boolean;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  select * into v_order from public.orders where id=p_order_id and user_id=v_actor for update;
  if not found then raise exception 'Pedido do checkout nao encontrado.'; end if;

  for v_index in 1..jsonb_array_length(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) loop
    v_payload:=p_items->(v_index-1); v_mode:=lower(trim(coalesce(v_payload->>'ownership_mode','')));
    if v_mode<>'named' then continue; end if;
    select * into v_item from public.order_items where order_id=v_order.id and item_position=v_index for update;
    if not found then raise exception 'Item nomeado do checkout nao encontrado na posicao %.',v_index; end if;
    if v_item.registration_contact_id is not null and v_item.participant_id is not null then continue; end if;

    v_name:=nullif(trim(coalesce(v_payload->>'holder_full_name','')),'');
    v_contact:=null;
    v_participant:=null;
    v_cpf:=nullif(regexp_replace(coalesce(v_payload->>'holder_cpf',''),'\D','','g'),'');
    v_email:=lower(nullif(trim(coalesce(v_payload->>'holder_email','')),''));
    v_phone:=nullif(regexp_replace(coalesce(v_payload->>'holder_phone',''),'\D','','g'),'');
    v_contact_id:=nullif(trim(coalesce(v_payload->>'holder_registration_contact_id','')),'')::uuid;
    v_has_reliable_identity:=v_name is not null and (
      v_contact_id is not null or public.is_valid_cpf(v_cpf)
      or (v_email is not null and v_email like '%_@_%._%' and length(v_phone)>=10)
    );

    select * into v_ticket from public.tickets where order_item_id=v_item.id for update;
    if not found then v_ticket.id:=null; v_ticket.owner_user_id:=null; end if;
    if not v_has_reliable_identity then
      update public.order_items set participant_id=null,registration_contact_id=null,ownership_status='unassigned',updated_at=now() where id=v_item.id;
      if found then update public.tickets set participant_id=null where id=v_ticket.id; end if;
      if not exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open'
        and i.issue_type='insufficient_named_holder_identity') then
        insert into public.participant_data_issues(organization_id,event_id,participant_id,registration_contact_id,order_item_id,ticket_id,
          field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery,resolution_scope)
        values(v_order.organization_id,v_item.event_id,null,null,v_item.id,v_ticket.id,'ticket_holder_identity',
          'insufficient_named_holder_identity','Titular informado sem dados suficientes para identificação',false,false,false,false,'admin_only');
      end if;
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      values('named_ticket_holder_pending','order_items',v_item.id,v_item.event_id,jsonb_build_object(
        'actor_user_id',v_actor,'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket.id,
        'holder_full_name_snapshot',v_name,'reason','insufficient_named_holder_identity'));
      continue;
    end if;

    if v_contact_id is not null then
      select * into v_contact from public.registration_contacts where id=v_contact_id and organization_id=v_order.organization_id for update;
      if not found then raise exception 'Cadastro indicado para titular nao pertence a organizacao.'; end if;
      if public.is_valid_cpf(v_cpf) and public.is_valid_cpf(v_contact.cpf)
        and regexp_replace(v_contact.cpf,'\D','','g')<>v_cpf then raise exception 'CPF do titular diverge do cadastro indicado.'; end if;
    elsif public.is_valid_cpf(v_cpf) then
      select count(*),(array_agg(rc.id order by rc.id))[1] into v_contact_count,v_contact_id
      from public.registration_contacts rc where rc.organization_id=v_order.organization_id
        and regexp_replace(coalesce(rc.cpf,''),'\D','','g')=v_cpf;
      if v_contact_count>1 then raise exception 'Conflito de identidade: CPF do titular possui mais de um cadastro.'; end if;
      if v_contact_count=1 then select * into v_contact from public.registration_contacts where id=v_contact_id for update; end if;
    end if;

    -- E-mail+telefone autorizam criar uma identidade nova, mas nunca localizar/mesclar uma existente.
    if v_contact.id is null then
      insert into public.registration_contacts(organization_id,full_name,cpf,phone,email,created_by)
      values(v_order.organization_id,v_name,case when public.is_valid_cpf(v_cpf) then v_cpf end,v_phone,v_email,v_actor)
      returning * into v_contact;
    else
      update public.registration_contacts set
        phone=coalesce(phone,v_phone),email=coalesce(email,v_email),updated_at=now()
      where id=v_contact.id returning * into v_contact;
    end if;

    select count(*),(array_agg(p.id order by p.id))[1] into v_participant_count,v_participant.id
    from public.participants p where p.event_id=v_item.event_id and p.registration_contact_id=v_contact.id;
    if v_participant_count>1 then raise exception 'Conflito de titularidade: cadastro possui mais de uma projecao no evento.'; end if;
    if v_participant_count=1 then
      select * into v_participant from public.participants where id=v_participant.id for update;
    else
      insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
        registration_status,reservation_status,notes)
      values(v_item.event_id,v_order.organization_id,v_contact.id,null,v_contact.full_name,v_contact.cpf,v_contact.birth_date,
        v_contact.gender,v_contact.phone,v_contact.email,v_contact.city,
        case when v_item.status='confirmed' then 'confirmed' else 'pending' end,
        case when v_item.status='confirmed' then 'confirmed' else 'pending' end,'LEGACY projection of named checkout holder')
      returning * into v_participant;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_item.event_id::text||':'||v_contact.id::text,0));
    if exists(select 1 from public.order_items oi left join public.participants op on op.id=oi.participant_id
      where oi.event_id=v_item.event_id and oi.id<>v_item.id
      and coalesce(oi.registration_contact_id,op.registration_contact_id)=v_contact.id
      and oi.status not in('cancelled','expired','refunded')) then
      raise exception using errcode='P0001',message='HOLDER_ALREADY_HAS_TICKET_FOR_EVENT',
        detail=jsonb_build_object('code','HOLDER_ALREADY_HAS_TICKET_FOR_EVENT','message','Esta pessoa ja e titular de outro ingresso neste evento.')::text;
    end if;

    update public.order_items set participant_id=v_participant.id,registration_contact_id=v_contact.id,
      holder_full_name=coalesce(v_name,v_contact.full_name),ownership_status='assigned',updated_at=now() where id=v_item.id;
    if v_ticket.id is not null then update public.tickets set participant_id=v_participant.id where id=v_ticket.id; end if;
    update public.participant_kit_items set participant_id=v_participant.id where order_item_id=v_item.id;
    update public.participant_data_issues set status='resolved',resolved_at=now(),resolved_by=v_actor,updated_at=now()
      where order_item_id=v_item.id and status='open' and issue_type='insufficient_named_holder_identity';
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('named_ticket_holder_materialized',case when v_ticket.id is null then 'order_items' else 'tickets' end,
      coalesce(v_ticket.id,v_item.id),v_item.event_id,jsonb_build_object('actor_user_id',v_actor,'order_id',v_order.id,
        'order_item_id',v_item.id,'ticket_id',v_ticket.id,'participant_id',v_participant.id,
        'registration_contact_id',v_contact.id,'owner_user_id',v_ticket.owner_user_id,'holder_full_name_snapshot',v_name));
  end loop;
end; $$;

create or replace function public.create_multi_ticket_order_checkout(
  p_event_id uuid,p_ticket_category_id uuid,p_gender text,p_quantity integer,p_payment_method text,
  p_coupon_code text default null,p_shirt_type text default null,p_shirt_size text default null,
  p_buyer_full_name text default null,p_buyer_cpf text default null,p_buyer_birth_date date default null,
  p_buyer_gender text default null,p_buyer_phone text default null,p_buyer_email text default null,p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true,p_items jsonb default '[]'::jsonb,p_limit_per_order integer default 10,
  p_notes text default null,p_client_request_id text default null
) returns table(order_id uuid,payment_id uuid,order_number text,payment_status text,reservation_expires_at timestamptz,
  item_count integer,amount numeric,discount_amount numeric,final_amount numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result record;
begin
  select * into v_result from public.create_multi_ticket_order_checkout_inventory_legacy(
    p_event_id,p_ticket_category_id,p_gender,p_quantity,p_payment_method,p_coupon_code,p_shirt_type,p_shirt_size,
    p_buyer_full_name,p_buyer_cpf,p_buyer_birth_date,p_buyer_gender,p_buyer_phone,p_buyer_email,p_buyer_city,
    p_assign_first_to_buyer,p_items,p_limit_per_order,p_notes,p_client_request_id) limit 1;
  perform public.materialize_named_checkout_holders(v_result.order_id,p_items);
  return query select v_result.order_id,v_result.payment_id,v_result.order_number,v_result.payment_status,
    v_result.reservation_expires_at,v_result.item_count,v_result.amount,v_result.discount_amount,v_result.final_amount;
end; $$;

revoke all on function public.materialize_named_checkout_holders(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) to authenticated;

commit;
