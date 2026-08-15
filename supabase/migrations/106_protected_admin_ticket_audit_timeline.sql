-- 106_protected_admin_ticket_audit_timeline.sql
-- Leitura administrativa restrita da auditoria do ingresso e payload futuro de troca de camiseta.
begin;

create or replace function public.get_admin_ticket_audit_timeline(p_ticket_id uuid)
returns table(id uuid,action text,entity_type text,entity_id uuid,event_id uuid,details jsonb,created_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_order_item_id uuid; v_order_id uuid; v_payment_id uuid;
begin
  if v_actor is null or not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('orders.view')
  ) then raise exception 'Sem permissao para consultar o historico do ingresso.'; end if;
  select * into v_ticket from public.tickets where tickets.id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso a organizacao.';
  end if;
  v_order_item_id:=v_ticket.order_item_id;
  select oi.order_id into v_order_id from public.order_items oi
    where oi.id=v_order_item_id and oi.event_id=v_ticket.event_id;
  if v_order_id is null then v_order_id:=v_ticket.order_id; end if;
  select o.payment_id into v_payment_id from public.orders o
    where o.id=v_order_id and o.event_id=v_ticket.event_id and o.organization_id=v_ticket.organization_id;
  return query
  select al.id,al.action,al.entity_type,al.entity_id,al.event_id,al.details,al.created_at
  from public.audit_logs al
  where al.event_id=v_ticket.event_id and (
    (al.entity_type='tickets' and al.entity_id=v_ticket.id)
    or al.entity_id in(v_ticket.participant_id,v_order_item_id,v_order_id,v_payment_id)
    or exists(select 1 from public.participant_kit_items pki where pki.ticket_id=v_ticket.id and pki.id=al.entity_id)
  )
  order by al.created_at,al.id;
end; $$;

do $migration$
declare
  v_signature regprocedure:=to_regprocedure('public.admin_change_ticket_shirt(uuid,text,text)');
  v_definition text; v_normalized text;
  v_expected text:=$old$jsonb_build_object('actor_user_id',v_actor,'kit_item_id',v_item.id,'variant_id',v_variant.id,'supply_mode',v_item.shirt_supply_mode)$old$;
  v_replacement text:=$new$jsonb_build_object('actor_user_id',v_actor,'kit_item_id',v_item.id,'variant_id',v_variant.id,'previous_variant_id',v_old_variant,'new_variant_id',v_variant.id,'supply_mode',v_item.shirt_supply_mode)$new$;
begin
  if v_signature is null then raise exception 'Funcao administrativa de camiseta nao encontrada.'; end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_normalized:=regexp_replace(lower(v_definition),'\s+','','g');
  if position('previous_variant_id' in v_normalized)>0 and position('new_variant_id' in v_normalized)>0 then return; end if;
  if position('current_user_has_permission(''inventory.change_participant_shirt'')' in v_normalized)=0
     or position('user_can_access_organization(v_actor,v_ticket.organization_id)' in v_normalized)=0
     or position(v_expected in v_definition)=0 then
    raise exception 'Definicao ativa diverge do contrato esperado da migration 104.';
  end if;
  v_definition:=replace(v_definition,v_expected,v_replacement);
  execute v_definition;
  select lower(pg_get_functiondef(v_signature)) into v_definition;
  if position('previous_variant_id' in v_definition)=0 or position('new_variant_id' in v_definition)=0 then
    raise exception 'Payload futuro de auditoria nao foi instalado.';
  end if;
end;
$migration$;

revoke all on function public.get_admin_ticket_audit_timeline(uuid) from public,anon,authenticated;
grant execute on function public.get_admin_ticket_audit_timeline(uuid) to authenticated;
revoke all on function public.admin_change_ticket_shirt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.admin_change_ticket_shirt(uuid,text,text) to authenticated;

commit;
