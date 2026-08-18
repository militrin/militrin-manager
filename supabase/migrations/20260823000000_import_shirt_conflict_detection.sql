-- Regra de produto confirmada durante a homologacao de Importacoes: quando a
-- mesma pessoa (mesmo registration_contact, identidade canonica) ja possui
-- inscricao ativa neste evento e a nova linha importada traz um tipo/tamanho
-- de camiseta DIFERENTE do que ja esta gravado, o sistema nunca deve decidir
-- sozinho qual valor vale. Antes desta migration nao havia nenhuma
-- infraestrutura para isso: o dedup de "pessoa ja importada" (migration
-- anterior) so marcava a linha inteira como duplicada, sem comparar o
-- conteudo da camiseta nem abrir uma pendencia especifica e comparavel.
--
-- Corrigido reaproveitando a infraestrutura JA existente e ja testada de
-- pendencias (participant_data_issues + o dialogo de resolucao em
-- src/app/inscricoes/participant-issues-dialog.tsx, que ja renderiza um
-- seletor tipo+tamanho carregando SOMENTE variantes reais do evento) em vez
-- de criar um subsistema novo: esta RPC apenas registra, de forma idempotente
-- e auditada, uma pendencia "shirt_selection/conflict" no ORDER_ITEM
-- EXISTENTE da pessoa (nunca cria um item novo). A resolucao (manter o valor
-- atual, usar o importado, ou escolher uma terceira variante valida) usa o
-- MESMO fluxo admin ja usado para qualquer outra pendencia de camiseta
-- (resolve_ticket_data_issues -> admin_change_ticket_shirt quando ja existe
-- ticket, ou update direto em order_items quando o ingresso ainda nao foi
-- confirmado) -- estoque tratado exatamente como qualquer outra troca de
-- camiseta admin: mexe em reserved_quantity, nunca em delivered_quantity.
begin;

create or replace function public.flag_import_shirt_conflict(
  p_import_batch_id uuid, p_import_batch_row_id uuid, p_order_item_id uuid,
  p_existing_shirt_type text, p_existing_shirt_size text,
  p_imported_shirt_type text, p_imported_shirt_size text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_batch public.import_batches%rowtype; v_message text; v_issue_id uuid; v_ticket_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('imports.view') then raise exception 'Sem permissao para importar cadastros.'; end if;
  select * into v_batch from public.import_batches where id=p_import_batch_id;
  if not found or v_batch.imported_by<>v_actor then raise exception 'Lote de importacao invalido.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id;
  if not found or not public.user_can_access_organization(v_actor,v_order.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;

  select id into v_ticket_id from public.tickets where order_item_id=v_item.id;

  select id into v_issue_id from public.participant_data_issues
    where order_item_id=p_order_item_id and field_code='shirt_selection' and issue_type='conflict' and status='open' limit 1;
  if v_issue_id is not null then
    update public.import_batch_rows set order_item_id=p_order_item_id where id=p_import_batch_row_id;
    return jsonb_build_object('issue_id',v_issue_id,'created',false);
  end if;

  v_message:=format('Conflito de camiseta: ja consta "%s %s"; a importacao trouxe "%s %s". Selecione o valor correto.',
    coalesce(nullif(trim(p_existing_shirt_type),''),'(sem tipo)'),coalesce(nullif(trim(p_existing_shirt_size),''),'(sem tamanho)'),
    coalesce(nullif(trim(p_imported_shirt_type),''),'(sem tipo)'),coalesce(nullif(trim(p_imported_shirt_size),''),'(sem tamanho)'));

  insert into public.participant_data_issues(organization_id,event_id,participant_id,registration_contact_id,import_batch_id,order_item_id,ticket_id,
    field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)
  values(v_order.organization_id,v_item.event_id,v_item.participant_id,v_item.registration_contact_id,p_import_batch_id,v_item.id,v_ticket_id,
    'shirt_selection','conflict',v_message,false,false,false,true)
  on conflict do nothing
  returning id into v_issue_id;

  if v_issue_id is null then
    select id into v_issue_id from public.participant_data_issues
      where order_item_id=p_order_item_id and field_code='shirt_selection' and issue_type='conflict' and status='open' limit 1;
  end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('import_shirt_conflict_detected','order_items',v_item.id,v_item.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'import_batch_id',p_import_batch_id,'import_batch_row_id',p_import_batch_row_id,
    'existing_shirt_type',p_existing_shirt_type,'existing_shirt_size',p_existing_shirt_size,
    'imported_shirt_type',p_imported_shirt_type,'imported_shirt_size',p_imported_shirt_size,'issue_id',v_issue_id));

  update public.import_batch_rows set order_item_id=p_order_item_id where id=p_import_batch_row_id;

  return jsonb_build_object('issue_id',v_issue_id,'created',true);
end; $$;

revoke all on function public.flag_import_shirt_conflict(uuid,uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.flag_import_shirt_conflict(uuid,uuid,uuid,text,text,text,text) to authenticated,service_role;

commit;
