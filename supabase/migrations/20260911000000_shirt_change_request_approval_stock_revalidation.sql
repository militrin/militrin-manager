begin;

-- P0 -- fecha o ciclo de aprovacao administrativa de solicitacoes de
-- alteracao de item (ex.: tamanho de camiseta). Auditoria confirmou que TODO
-- o backend ja existia (ticket_item_change_requests, request_ticket_item_
-- change, review_ticket_item_change_request, admin_change_ticket_shirt) --
-- a UNICA peca faltando era a tela administrativa de fila (nao criada aqui
-- em SQL, ver /operacoes/solicitacoes no frontend). Esta migration corrige
-- um unico gap real de concorrencia encontrado ao escrever o teste do
-- cenario "resta 1 unidade, 2 aprovacoes concorrentes": nenhuma das duas
-- devia vencer as duas.
--
-- Causa raiz: review_ticket_item_change_request delega a troca de camiseta
-- pra admin_change_ticket_shirt, cuja checagem de disponibilidade (shirt_
-- supply_mode='stock') compara so total_quantity-delivered_quantity contra
-- a quantidade -- de proposito NAO conta reserved_quantity, porque a regra
-- de negocio confirmada em 20260824000000_shirt_reservation_independent_of_
-- stock.sql e que RESERVAR (inclusive via edicao administrativa direta,
-- retirada, operacoes, importacao e autoatendimento de pendencia) e
-- independente do estoque fisico -- so a ENTREGA fisica e travada. Essa
-- migration NAO muda isso: admin_change_ticket_shirt e todos os OUTROS
-- chamadores continuam identicos, reserva sem teto fisico.
--
-- Mas a fila de APROVACAO e um caso diferente: e literalmente a arbitragem
-- de duas pessoas competindo pela mesma unidade fisica que o organizador
-- ainda nao entregou a nenhuma -- ao contrario de "reservar um tamanho antes
-- da camiseta chegar" (o caso de uso original da 20260824), aqui o
-- organizador esta decidindo NA HORA quem fica com a vaga. Corrigido
-- adicionando, SO dentro de review_ticket_item_change_request, uma
-- revalidacao estrita (total_quantity-reserved_quantity-delivered_quantity
-- >= quantidade, com SELECT...FOR UPDATE na linha de estoque da variante
-- solicitada) antes de delegar pra admin_change_ticket_shirt -- exatamente
-- quando shirt_supply_mode='stock' (em made_to_order continua sem teto,
-- mesma filosofia existente). Reusa o mesmo erro estruturado
-- SHIRT_OUT_OF_STOCK (raise_shirt_out_of_stock) que toda a UI (Minha Conta,
-- Operacoes, e agora a fila de solicitacoes) ja sabe traduzir pra mensagem
-- amigavel -- nenhum codigo de erro novo.
create or replace function public.review_ticket_item_change_request(p_request_id uuid, p_decision text, p_notes text default null) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid:=auth.uid(); v_req public.ticket_item_change_requests%rowtype; v_item public.event_kit_items%rowtype;
  v_link public.participant_kit_items%rowtype; v_variant public.event_kit_item_variants%rowtype; v_event public.events%rowtype;
  v_old_inv public.event_kit_item_variant_inventory%rowtype; v_new_inv public.event_kit_item_variant_inventory%rowtype;
  v_decision text:=lower(trim(p_decision)); v_qty integer; v_delivered boolean; v_shirt_type text; v_shirt_available integer;
begin
  if v_actor is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para revisar solicitacao.'; end if;
  if v_decision not in('approved','rejected') then raise exception 'Decisao invalida.'; end if;
  select * into v_req from public.ticket_item_change_requests where id=p_request_id for update;
  if not found or v_req.status<>'pending' then raise exception 'Solicitacao inexistente ou ja revisada.'; end if;
  if not public.user_can_access_organization(v_actor,v_req.organization_id) then raise exception 'Sem acesso a organizacao.'; end if;
  if v_decision='approved' then
    select * into v_event from public.events where id=v_req.event_id;
    select * into v_item from public.event_kit_items where id=v_req.kit_item_id and event_id=v_req.event_id and is_active for update;
    if not found or not v_event.allow_participant_item_changes or not v_item.allow_participant_change or not v_item.requires_variant then raise exception 'Alteracao nao esta mais habilitada para o item.'; end if;
    select * into v_variant from public.event_kit_item_variants where id=v_req.requested_variant_id and kit_item_id=v_req.kit_item_id and is_active;
    if not found then raise exception 'Variante solicitada nao esta mais disponivel.'; end if;
    select * into v_link from public.participant_kit_items where id=v_req.participant_kit_item_id and ticket_id=v_req.ticket_id and kit_item_id=v_req.kit_item_id for update;
    if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
    v_qty:=greatest(v_link.quantity,1); v_delivered:=v_link.status='delivered';
    if v_item.item_type='shirt' then
      -- Revalidacao estrita SO da fila de aprovacao (ver comentario acima):
      -- entre a solicitacao e a revisao, o estoque fisico realmente
      -- disponivel para NOVAS aprovacoes ja desconta o que outras
      -- aprovacoes/entregas reservaram/entregaram nesse meio tempo -- nunca
      -- confia no numero mostrado na UI no momento em que o admin abriu a
      -- tela. Fora do modo 'stock' (made_to_order) continua sem teto fisico,
      -- exatamente como admin_change_ticket_shirt.
      if v_item.shirt_supply_mode='stock' then
        insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
        values(v_req.organization_id,v_req.event_id,v_item.id,v_variant.id,0)
        on conflict(kit_item_id,variant_id) do nothing;
        select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
        v_shirt_available:=greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.reserved_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0);
        if v_shirt_available<v_qty then
          perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_shirt_available);
        end if;
      end if;
      select shirt_type into v_shirt_type from public.order_items where id=(select order_item_id from public.tickets where id=v_req.ticket_id);
      perform public.change_ticket_shirt(v_req.ticket_id,v_shirt_type,v_variant.value);
      update public.participant_kit_items set variant_data=coalesce(variant_data,'{}'::jsonb)||jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    else
      if v_item.track_variant_inventory then
        select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.current_variant_id for update;
        select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_req.kit_item_id and variant_id=v_req.requested_variant_id for update;
        if v_new_inv.id is null then raise exception 'Estoque nao configurado para a variante.'; end if;
        if v_new_inv.total_quantity-v_new_inv.reserved_quantity-v_new_inv.delivered_quantity<v_qty then raise exception 'Variante sem saldo disponivel.'; end if;
        if v_old_inv.id is not null then
          if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=greatest(delivered_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id;
          else update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
        end if;
        if v_delivered then update public.event_kit_item_variant_inventory set delivered_quantity=delivered_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
        else update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id; end if;
      end if;
      update public.participant_kit_items set variant_data=jsonb_build_object('variant_id',v_variant.id,'variant_name',v_variant.name,'variant_value',v_variant.value) where id=v_link.id;
    end if;
  end if;
  update public.ticket_item_change_requests set status=v_decision,reviewed_by=v_actor,reviewed_at=now(),review_notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now() where id=p_request_id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_item_change_'||v_decision,'tickets',v_req.ticket_id,v_req.event_id,
    jsonb_build_object('request_id',v_req.id,'kit_item_id',v_req.kit_item_id,'current_variant_id',v_req.current_variant_id,'requested_variant_id',v_req.requested_variant_id,'actor_user_id',v_actor));
  return true;
end; $$;

commit;
