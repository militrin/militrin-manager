begin;

-- Auditoria da Central de Integridade Operacional: PAID_ORDER_WITHOUT_TICKET
-- so verifica "existe ticket ativo?" -- quando um Owner cancela um ingresso
-- de proposito (ex.: duplicidade, teste, pedido cancelado) SEM emitir
-- substituto, o detector nunca sabe que aquele cancelamento foi definitivo.
-- Caso real encontrado: pedido MIL-2026-00001078 (ingresso cortesia
-- administrativo, cancelado via admin_cancel_ticket com reason_code
-- 'administrative_correction' pouco depois de emitido) -- o pagamento
-- continua 'paid', o order_item continua 'confirmed', e a Central bloqueia
-- pra sempre pedindo um novo ingresso que ninguem pediu.
--
-- O modelo atual (tickets.status='cancelled' + audit_logs.details.reason_code
-- em texto livre) nunca capturou a INTENCAO do cancelamento -- so o motivo.
-- Extensao minima: 3 colunas em `tickets` (espelhando o que ja ia soh pro
-- audit_logs) mais um booleano explicito que o proprio ator declara no
-- momento do cancelamento: essa exclusao encerra definitivamente o
-- entitlement (replacement_required=false) ou exige substituicao/reemissao
-- (replacement_required=true, o default seguro quando a intencao nao e'
-- informada por um caminho legado)?
alter table public.tickets
  add column if not exists cancellation_reason_code text,
  add column if not exists cancellation_reason_text text,
  add column if not exists cancellation_replacement_required boolean;

comment on column public.tickets.cancellation_replacement_required is
  'Intencao declarada pelo Owner no cancelamento: true = espera-se um ingresso substituto (PAID_ORDER_WITHOUT_TICKET continua bloqueando); false = entitlement encerrado definitivamente, nenhum substituto e esperado; null = cancelamento legado sem intencao registrada (tratado como true/bloqueante, nunca assumido como resolvido silenciosamente).';

-- owner_cancel_ticket passa a exigir a intencao explicitamente (sem default:
-- forca todo chamador -- inclusive o legado admin_cancel_ticket abaixo -- a
-- decidir). Tambem deixa de ser no-op quando o ingresso ja esta cancelado:
-- permite reclassificar a intencao de um cancelamento ja feito (o unico jeito
-- de um Owner corrigir, pela propria tela, um cancelamento antigo que nunca
-- registrou essa decisao -- sem precisar de UPDATE manual em producao).
--
-- AUDITORIA DE AUTORIZACAO (revisao pre-push): esta funcao usava
-- is_organization_owner (flag organization_members.is_owner), enquanto TODO
-- o resto do sistema que protege acoes administrativas sensiveis usa o
-- idioma padrao user_can_access_organization(actor,org) AND (is_active_owner(actor)
-- OR resolve_user_permission(actor,'<codigo>')) -- ver resolve_ticket_data_issues,
-- resolve_import_ticket_options, update_participant_event_notes, etc. Isso
-- criava exatamente a inconsistencia relatada: /ingressos/[ticketId]/editar
-- ja usa assertPermission('orders.cancel') e mostra o botao pra qualquer
-- admin/moderador com essa permissao concedida, mas a RPC so aceitava quem
-- fosse Owner da organizacao -- "frontend permite, RPC rejeita". Confirmado
-- no catalogo (admin_permissions.code='orders.cancel', modulo 'orders',
-- descricao "Cancela pedidos"): a permissao foi desenhada de proposito pra
-- ser concedida a administradores/moderadores, nao e um acidente de UI.
-- Corrigido para o MESMO idioma padrao do resto do sistema: quem tem
-- orders.cancel concedido (por um Owner, via tela de funcoes) cancela
-- ingressos normalmente; o Owner (is_active_owner, papel administrativo,
-- nao a flag de organization_members) continua podendo sempre, como bypass
-- de seguranca -- igual a todo outro fluxo administrativo do sistema. A
-- exclusao de cadastro (prepare_owner_registration_contact_deletion)
-- continua deliberadamente Owner-only: remove identidade + conta Auth de
-- forma irreversivel, um patamar de risco maior que cancelar 1 ingresso
-- (que pode ser reemitido/reclassificado). owner_cancel_store_order_item
-- (mesma migration 20260891) nao foi alterada aqui -- fora do escopo desta
-- auditoria, que e especificamente sobre ingresso.
drop function if exists public.owner_cancel_ticket(uuid, text, text);

create or replace function public.owner_cancel_ticket(
  p_ticket_id uuid, p_reason_code text, p_reason_text text default null, p_replacement_required boolean default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_link record; v_reason_text text; v_was_cancelled boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets as ticket where ticket.id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not (public.user_can_access_organization(v_actor,v_ticket.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'orders.cancel')))
  then raise exception 'Sem permissao para cancelar ingresso.'; end if;
  if nullif(trim(coalesce(p_reason_code,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  if p_reason_code='other' and nullif(trim(coalesce(p_reason_text,'')),'') is null then raise exception 'Descreva o motivo da exclusao.'; end if;
  if p_replacement_required is null then raise exception 'Informe se este ingresso precisa ser substituido.'; end if;
  v_reason_text:=nullif(trim(coalesce(p_reason_text,'')),'');
  v_was_cancelled:=(v_ticket.status='cancelled');

  if v_was_cancelled then
    if v_ticket.cancellation_reason_code is not distinct from p_reason_code
      and v_ticket.cancellation_reason_text is not distinct from v_reason_text
      and v_ticket.cancellation_replacement_required is not distinct from p_replacement_required then
      return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id,'reclassified',false);
    end if;
    update public.tickets as ticket set
      cancellation_reason_code=p_reason_code,cancellation_reason_text=v_reason_text,cancellation_replacement_required=p_replacement_required
      where ticket.id=v_ticket.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('ticket_cancellation_reclassified','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object(
      'actor_user_id',v_actor,'reason_code',p_reason_code,'reason_text',v_reason_text,'replacement_required',p_replacement_required,
      'previous_reason_code',v_ticket.cancellation_reason_code,'previous_replacement_required',v_ticket.cancellation_replacement_required));
    return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'reclassified',true,'status','cancelled');
  end if;

  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso possui check-in realizado. Desfaca o check-in antes de exclui-lo.'; end if;
  if exists(select 1 from public.participant_kit_items as kit_link where kit_link.ticket_id=v_ticket.id and kit_link.status='delivered') then
    raise exception 'Este ingresso possui itens entregues. Desfaca a entrega antes de exclui-lo.';
  end if;

  for v_link in
    select kit_link.id from public.participant_kit_items as kit_link
    where kit_link.ticket_id=v_ticket.id and kit_link.status<>'cancelled' order by kit_link.id for update
  loop
    update public.participant_kit_items as kit_link set status='cancelled' where kit_link.id=v_link.id;
  end loop;
  update public.tickets as ticket set
    status='cancelled',cancelled_at=coalesce(ticket.cancelled_at,now()),
    cancellation_reason_code=p_reason_code,cancellation_reason_text=v_reason_text,cancellation_replacement_required=p_replacement_required
    where ticket.id=v_ticket.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('admin_ticket_cancelled','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('actor_user_id',v_actor,'reason_code',p_reason_code,'reason_text',v_reason_text,'replacement_required',p_replacement_required,'cancelled_at',now()));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'reclassified',false,'status','cancelled');
end; $$;

revoke all on function public.owner_cancel_ticket(uuid,text,text,boolean) from public,anon;
grant execute on function public.owner_cancel_ticket(uuid,text,text,boolean) to authenticated,service_role;

-- Caminho legado de texto livre (chamado hoje por /ingressos/[ticketId]/editar,
-- cancelTicketAction em src/app/ingressos/[ticketId]/editar/actions.ts).
-- Ganha o mesmo parametro de intencao, com default seguro (true = continua
-- bloqueando) para nao mudar silenciosamente o comportamento de nenhum
-- chamador que ainda nao foi atualizado pra informar a escolha do Owner.
drop function if exists public.admin_cancel_ticket(uuid, text);

create or replace function public.admin_cancel_ticket(p_ticket_id uuid,p_reason text,p_replacement_required boolean default true)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return public.owner_cancel_ticket(p_ticket_id,'administrative_correction',p_reason,coalesce(p_replacement_required,true));
end; $$;

revoke all on function public.admin_cancel_ticket(uuid,text,boolean) from public,anon;
grant execute on function public.admin_cancel_ticket(uuid,text,boolean) to authenticated,service_role;

-- PAID_ORDER_WITHOUT_TICKET deixa de bloquear apenas quando existe um
-- cancelamento com intencao EXPLICITA de nao substituir. NULL (legado,
-- intencao nunca registrada) continua bloqueando -- nunca tratamos silencio
-- como "resolvido".
create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Pedido pago sem ingresso emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o ingresso correspondente não foi emitido.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/inscricoes/pedido/' || o.id,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status,
      'event_name', e.name, 'holder_name', coalesce(rc.full_name, oi.holder_full_name),
      'final_amount', oi.final_amount
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null
    and not exists (
      select 1 from public.tickets ct
      where ct.order_item_id = oi.id and ct.status = 'cancelled' and ct.cancellation_replacement_required = false
    );
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

commit;
