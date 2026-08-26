begin;

-- P0 -- redesign do detalhe do ingresso do participante encontrou um bug
-- real na alteracao de categoria (auditoria desta tarefa, validada em
-- runtime contra o Supabase local):
--
-- updateTicketCategoryAction (src/app/minha-conta/actions.ts) ja exige
-- assertPermission('participants.edit_basic') antes de qualquer coisa --
-- um usuario comum (sem linha em admin_users) JA nao consegue chamar essa
-- Server Action (ela lanca PermissionDeniedError). Confirmado tambem que
-- public.order_items nao tem NENHUMA RLS policy de UPDATE/INSERT/DELETE
-- (so 4 policies de SELECT) -- ou seja, uma tentativa de UPDATE direto via
-- client (anon/authenticated key, sem passar pela Server Action) tambem ja
-- e recusada pelo Postgres hoje, para QUALQUER usuario, comum ou admin.
--
-- O bug real encontrado e o OPOSTO do que se poderia temer: a propria
-- Server Action faz esse UPDATE usando o client vinculado a sessao do
-- usuario (respeitando RLS, nao service role) -- e como nao ha policy de
-- UPDATE, a chamada "sucede" silenciosamente afetando 0 linhas (Postgres/
-- PostgREST nao retornam erro por RLS filtrar todas as linhas de um
-- UPDATE). A Server Action nunca conferia o resultado, entao reportava
-- sucesso mesmo sem mudar nada -- confirmado em teste real (owner com a
-- permissao certa, UPDATE direto via client anon-key: error=null, mas a
-- categoria permanecia inalterada).
--
-- Correcao: move a escrita para uma RPC SECURITY DEFINER dedicada
-- (admin_update_ticket_category), no mesmo padrao ja usado por toda
-- mutacao de order_items neste projeto (assign_order_item_participant,
-- owner_cancel_ticket, etc.) -- a permissao e checada DENTRO da funcao
-- (nao so na Server Action em JS), entao "bloquear tambem no backend/RPC"
-- passa a ser garantido pelo proprio Postgres, imune a qualquer chamada
-- direta que pule a Server Action. Nao criei nenhuma regra nova: a unica
-- autorizacao continua sendo a MESMA permissao 'participants.edit_basic'
-- que ja gateava isso -- administrador continua podendo fazer a correcao
-- exatamente como podia (ou deveria poder, ja que estava quebrado) antes.
create or replace function public.admin_update_ticket_category(p_ticket_id uuid, p_ticket_category_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_ticket public.tickets%rowtype;
  v_order_item public.order_items%rowtype;
  v_event_id uuid;
  v_previous_category_id uuid;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Usuario sem permissao para alterar a categoria deste ingresso.';
  end if;

  if p_ticket_id is null or p_ticket_category_id is null then
    raise exception 'Ingresso e categoria sao obrigatorios.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id;
  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;
  v_event_id := v_ticket.event_id;

  if v_ticket.order_item_id is null then
    raise exception 'Este ingresso nao possui item de pedido vinculado.';
  end if;

  select * into v_order_item from public.order_items where id = v_ticket.order_item_id for update;
  if not found then
    raise exception 'Item de pedido nao encontrado.';
  end if;
  v_previous_category_id := v_order_item.ticket_category_id;

  if not exists (
    select 1 from public.ticket_categories where id = p_ticket_category_id and event_id = v_event_id
  ) then
    raise exception 'Categoria nao pertence ao evento do ingresso.';
  end if;

  update public.order_items
  set ticket_category_id = p_ticket_category_id, updated_at = now()
  where id = v_order_item.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('ticket_category_changed', 'tickets', p_ticket_id, v_event_id,
    jsonb_build_object('actor_user_id', v_actor, 'previous_category_id', v_previous_category_id, 'ticket_category_id', p_ticket_category_id));
end;
$$;

revoke all on function public.admin_update_ticket_category(uuid, uuid) from public, anon;
grant execute on function public.admin_update_ticket_category(uuid, uuid) to authenticated, service_role;

commit;
