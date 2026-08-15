-- 138_ticket_holder_reason_taxonomy.sql
-- Motivos estruturados e auditoria de titularidade sem reclassificar o legado.

begin;

alter table public.ticket_holder_history
  add column if not exists reason_code text,
  add column if not exists reason_text text;

alter table public.ticket_holder_history drop constraint if exists ticket_holder_history_reason_code_check;
alter table public.ticket_holder_history add constraint ticket_holder_history_reason_code_check check(reason_code in(
  'registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
  'issuance_error','system_error','data_regularization','other','legacy_unclassified'
)) not valid;
alter table public.ticket_holder_history drop constraint if exists ticket_holder_history_reason_other_text_check;
alter table public.ticket_holder_history add constraint ticket_holder_history_reason_other_text_check
  check(reason_code<>'other' or nullif(trim(reason_text),'') is not null) not valid;
alter table public.ticket_holder_history drop constraint if exists ticket_holder_history_new_reason_required_check;
alter table public.ticket_holder_history add constraint ticket_holder_history_new_reason_required_check
  check(reason_code is not null) not valid;

-- Chamadas antigas continuam identificadas como legado, sem atribuir uma categoria humana ficticia.
-- Registros anteriores a esta migration permanecem intocados e podem continuar com reason_code nulo.
create or replace function public.trg_ticket_holder_history_reason_compatibility()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.reason_code is null then
    new.reason_code:='legacy_unclassified';
    new.reason_text:=coalesce(nullif(trim(new.reason_text),''),nullif(trim(new.reason),''));
  end if;
  if new.operation='ticket_transferred' then new.operation:='holder_changed'; end if;
  return new;
end; $$;
drop trigger if exists ticket_holder_history_reason_compatibility on public.ticket_holder_history;
create trigger ticket_holder_history_reason_compatibility before insert on public.ticket_holder_history
for each row execute function public.trg_ticket_holder_history_reason_compatibility();

alter table public.ticket_holder_history drop constraint if exists ticket_holder_history_operation_check;
alter table public.ticket_holder_history add constraint ticket_holder_history_operation_check
  check(operation in('holder_assigned','holder_changed','holder_removed','ticket_transferred'));

create or replace function public.admin_set_ticket_holder_contact(
  p_ticket_id uuid,p_registration_contact_id uuid,p_reason_code text,p_reason_text text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype;
  v_contact public.registration_contacts%rowtype; v_previous public.participants%rowtype;
  v_target public.participants%rowtype; v_target_count integer; v_operation text;
  v_reason_code text:=trim(coalesce(p_reason_code,'')); v_reason_text text:=nullif(trim(coalesce(p_reason_text,'')),'');
  v_previous_contact_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para alterar titular.'; end if;
  if v_reason_code not in('registration_correction','buyer_request','holder_request','third_party_ticket','administrative_adjustment',
    'issuance_error','system_error','data_regularization','other','legacy_unclassified') then raise exception 'Motivo de alteracao invalido.'; end if;
  if v_reason_code='other' and v_reason_text is null then raise exception 'Descreva o motivo da alteracao.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status in('cancelled','canceled','void','voided') then raise exception 'Ingresso cancelado nao pode ter titular alterado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso ja utilizado nao pode ter titular alterado.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if coalesce(v_item.participant_id,v_ticket.participant_id) is not null then
    select * into v_previous from public.participants where id=coalesce(v_item.participant_id,v_ticket.participant_id);
  end if;
  v_previous_contact_id:=coalesce(v_item.registration_contact_id,v_previous.registration_contact_id);

  if p_registration_contact_id is null then
    if v_previous.id is null and v_item.registration_contact_id is null then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id); end if;
    update public.order_items set participant_id=null,registration_contact_id=null,holder_full_name=null,ownership_status='unassigned',updated_at=now() where id=v_item.id;
    update public.tickets set participant_id=null where id=v_ticket.id;
    insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
      previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,reason_code,reason_text)
    values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,'holder_removed',v_previous.id,null,
      v_previous_contact_id,null,v_previous.user_id,null,v_actor,'admin',v_reason_text,v_reason_code,v_reason_text);
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('holder_removed','tickets',v_ticket.id,v_ticket.event_id,
      jsonb_build_object('ticket_id',v_ticket.id,'previous_participant_id',v_previous.id,'new_participant_id',null,
        'previous_registration_contact_id',v_previous_contact_id,'new_registration_contact_id',null,
        'previous_user_id',v_previous.user_id,'new_user_id',null,'actor_user_id',v_actor,'reason_code',v_reason_code,'reason_text',v_reason_text));
    return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'registration_contact_id',null);
  end if;

  select * into v_contact from public.registration_contacts where id=p_registration_contact_id and organization_id=v_ticket.organization_id for update;
  if not found then raise exception 'Cadastro de destino invalido ou de outra organizacao.'; end if;
  if v_previous_contact_id=v_contact.id then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id,'registration_contact_id',v_contact.id); end if;
  perform public.assert_ticket_holder_contact_available(v_ticket.id,v_ticket.event_id,v_contact.id);
  select count(*) into v_target_count from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact.id;
  if v_target_count>1 then raise exception 'VALIDACAO_ADMINISTRATIVA: cadastro possui multiplas projecoes no evento.'; end if;
  if v_target_count=1 then
    select * into strict v_target from public.participants where event_id=v_ticket.event_id and registration_contact_id=v_contact.id;
  else
    insert into public.participants(event_id,organization_id,registration_contact_id,user_id,full_name,cpf,birth_date,gender,phone,email,city,
      shirt_type,shirt_size,registration_status,ticket_category_id,batch_id)
    values(v_ticket.event_id,v_ticket.organization_id,v_contact.id,null,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,
      v_contact.phone,v_contact.email,v_contact.city,nullif(trim(coalesce(v_item.shirt_type,'')),''),nullif(trim(coalesce(v_item.shirt_size,'')),''),
      'confirmed',v_item.ticket_category_id,v_item.batch_id) returning * into v_target;
  end if;
  v_operation:=case when v_previous.id is null then 'holder_assigned' else 'holder_changed' end;
  update public.order_items set participant_id=v_target.id,registration_contact_id=v_contact.id,holder_full_name=v_contact.full_name,
    ownership_status=case when v_operation='holder_assigned' then 'assigned' else 'transferred' end,updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=v_target.id where id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,
    previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,reason_code,reason_text)
  values(v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,v_operation,v_previous.id,v_target.id,
    v_previous_contact_id,v_contact.id,v_previous.user_id,v_target.user_id,v_actor,'admin',v_reason_text,v_reason_code,v_reason_text);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values(v_operation,'tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('ticket_id',v_ticket.id,'previous_participant_id',v_previous.id,'new_participant_id',v_target.id,
      'previous_registration_contact_id',v_previous_contact_id,'new_registration_contact_id',v_contact.id,
      'previous_user_id',v_previous.user_id,'new_user_id',v_target.user_id,'actor_user_id',v_actor,'reason_code',v_reason_code,'reason_text',v_reason_text));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'participant_id',v_target.id,'registration_contact_id',v_contact.id);
end; $$;

-- Wrapper temporario. O texto livre antigo e preservado, mas explicitamente nao classificado.
create or replace function public.admin_set_ticket_holder_contact(p_ticket_id uuid,p_registration_contact_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  return public.admin_set_ticket_holder_contact(p_ticket_id,p_registration_contact_id,'legacy_unclassified',nullif(trim(coalesce(p_reason,'')),''));
end; $$;

revoke all on function public.admin_set_ticket_holder_contact(uuid,uuid,text,text),public.admin_set_ticket_holder_contact(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_set_ticket_holder_contact(uuid,uuid,text,text),public.admin_set_ticket_holder_contact(uuid,uuid,text) to authenticated;

commit;
