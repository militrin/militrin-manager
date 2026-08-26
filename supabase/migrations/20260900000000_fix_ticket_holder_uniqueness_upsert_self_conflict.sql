-- Corrige bug real de idempotencia confirmado pelos testes de integracao da
-- fundacao de pagamentos (Fase 1 Asaas): reconfirmar um order_item cujo
-- ticket ja existe e esta 'active' ou 'used' sempre falhava com
-- HOLDER_ALREADY_HAS_TICKET_FOR_EVENT, mesmo sendo o PROPRIO ticket -- o que
-- quebraria a idempotencia de um webhook de pagamento duplicado assim que a
-- Fase 2 conectar o Asaas de verdade.
--
-- CAUSA RAIZ (confirmada por reproducao direta em psql -- RAISE NOTICE
-- temporario em sessao interativa, nunca commitado em nenhuma migration --
-- nao apenas pelo diagnostico do teste):
--
--   confirm_order_item_and_issue_ticket (endurecida na migration
--   20260897000000, mas a ESTRUTURA do upsert ja existia antes dela) usa
--
--     insert into tickets(...) values(...)
--     on conflict(order_item_id) where order_item_id is not null do update set ...
--
--   O trigger enforce_ticket_holder_contact_uniqueness em tickets
--   (BEFORE INSERT OR UPDATE OF participant_id, event_id, status,
--   order_item_id, funcao trg_enforce_ticket_holder_contact_uniqueness,
--   definida por ultimo em 20260851000000_scope_holder_uniqueness_trigger_to_identity_changes.sql)
--   dispara com TG_OP='INSERT' para ESSA MESMA instrucao mesmo quando ela vai
--   cair no ramo ON CONFLICT DO UPDATE -- o Postgres roda o BEFORE INSERT
--   ROW trigger ANTES de detectar o conflito, entao NEW ali e so a linha que o
--   INSERT propos (com um id novo aleatorio vindo do DEFAULT
--   gen_random_uuid(), nunca o id real do ticket que ja existe) e OLD e
--   sempre NULL. A funcao entao chama assert_ticket_holder_contact_available
--   passando esse id ERRADO como "ticket a ignorar" -- registration_contact_has_active_ticket
--   nunca exclui o proprio ticket, encontra ele mesmo (status 'active' ou
--   'used', que nao esta em cancelled/canceled/void/voided) como se fosse
--   "outro" ingresso do mesmo titular, e a funcao lanca
--   HOLDER_ALREADY_HAS_TICKET_FOR_EVENT sempre.
--
--   Confirmado tambem, na MESMA sessao de reproducao, que quando o INSERT
--   realmente conflita, o Postgres SEMPRE dispara o trigger uma SEGUNDA vez,
--   agora com TG_OP='UPDATE' e OLD/NEW corretos (a linha existente antes, e o
--   resultado real do SET da clausula DO UPDATE depois) -- a logica de
--   "identidade inalterada" ja existente (da migration 20260851000000) esta
--   CORRETA e ja resolveria isso sozinha, so nunca chega a rodar porque a
--   PRIMEIRA chamada (modo INSERT) ja lanca a excecao antes.
--
-- Auditoria completa feita antes desta correcao (schema atual, nao so o
-- diagnostico do teste anterior):
--   - registration_contact_has_active_ticket e assert_ticket_holder_contact_available:
--     inalteradas desde a criacao, corretas -- ja excluem por id quando
--     recebem o id certo. Nao precisam mudar.
--   - confirm_order_item_and_issue_ticket (migration 20260897000000): correta,
--     nao precisa mudar -- o bug e inteiramente do lado do trigger, antes
--     mesmo do UPSERT decidir qualquer coisa sobre status.
--   - ux_tickets_order_item_id_all: UNIQUE btree total em (order_item_id),
--     inalterada -- e o arbiter index correto do ON CONFLICT, nao e a causa.
--   - Os 16 outros escritores atuais de tickets (admin_set_ticket_holder_contact,
--     admin_transfer_ticket_ownership, admin_update_payment_status,
--     assign_order_item_participant, change_ticket_holder_by_pin_for_owner/_internal,
--     checkin_ticket_entry, issue_manual_ticket_batch,
--     materialize_named_checkout_holders, owner_cancel_ticket,
--     reconcile_registration_contact_account, sync_order_item_participant_to_ticket,
--     undo_participant_checkin, undo_ticket_checkin, _apply_terminal_order_payment_status)
--     usam UPDATE simples ou INSERT sem ON CONFLICT em tickets -- nenhum usa
--     INSERT...ON CONFLICT DO UPDATE nessa tabela alem de
--     confirm_order_item_and_issue_ticket. So esse caminho e afetado, mas a
--     correcao abaixo e feita no TRIGGER (nao em confirm_order_item_and_issue_ticket)
--     para proteger tambem qualquer futuro caller que venha a usar o mesmo
--     padrao de upsert.
--
-- SOLUCAO ESCOLHIDA: resolver a existencia do ticket pelo order_item_id ANTES
-- de validar, dentro do proprio trigger (opcao "resolver o ticket existente
-- pelo order_item_id antes da checagem", a mais segura e centralizada das
-- avaliadas). Quando TG_OP='INSERT' e ja existe uma linha para este
-- order_item_id, este INSERT vai necessariamente conflitar -- a funcao
-- devolve NEW sem validar nada, confiando 100% na segunda chamada
-- (TG_OP='UPDATE', com OLD/NEW corretos, ja comprovada acima) para fazer a
-- validacao real. Nenhuma outra logica muda: a regra "1 titular por pessoa
-- por evento" continua exatamente a mesma, so passa a ser avaliada com os
-- dados certos. NAO remove o trigger, NAO remove a constraint de unicidade,
-- NAO enfraquece a regra -- so corrige QUANDO ela e avaliada.
--
-- Comportamento antes/depois (mesmo cenario: reconfirmar
-- confirm_order_item_and_issue_ticket para um order_item cujo ticket ja
-- existe):
--   ticket existente 'active' ou 'used', identidade (participant_id/
--   order_item_id) inalterada -> ANTES: sempre HOLDER_ALREADY_HAS_TICKET_FOR_EVENT
--   (bug). DEPOIS: idempotente, retorna o mesmo ticket, nenhuma mudanca.
--   ticket existente 'cancelled' -> ANTES e DEPOIS: bloqueado por
--   confirm_order_item_and_issue_ticket (migration 20260897000000), que roda
--   normalmente porque a insercao em si nao falha mais.
--   um SEGUNDO ticket (order_item diferente) para o MESMO titular no MESMO
--   evento -> ANTES e DEPOIS: continua bloqueado -- e um INSERT novo (sem
--   conflito por order_item_id), passa pela validacao normal, que segue
--   inalterada.
begin;

create or replace function public.trg_enforce_ticket_holder_contact_uniqueness()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_contact uuid; v_ticket_id uuid; v_event_id uuid; v_identity_unchanged boolean; v_reactivating boolean;
  v_will_conflict boolean;
begin
  if tg_table_name='tickets' then
    v_ticket_id:=new.id; v_event_id:=new.event_id;

    -- INSERT ... ON CONFLICT (order_item_id) DO UPDATE dispara este trigger
    -- BEFORE INSERT com TG_OP='INSERT' mesmo quando vai cair no ramo de
    -- conflito -- o Postgres so decide isso DEPOIS que o BEFORE INSERT
    -- termina. Se ja existe uma linha com este order_item_id, este INSERT
    -- vai necessariamente conflitar: nao validar aqui (os dados de NEW/OLD
    -- ainda nao refletem o resultado real do conflito) e confiar na segunda
    -- chamada deste MESMO trigger, que o Postgres dispara com TG_OP='UPDATE'
    -- e OLD/NEW corretos assim que a resolucao do conflito acontece.
    if tg_op='INSERT' and new.order_item_id is not null then
      select exists(select 1 from public.tickets where order_item_id=new.order_item_id) into v_will_conflict;
      if v_will_conflict then
        return new;
      end if;
    end if;

    if new.status in ('cancelled','canceled','void','voided') then return new; end if;

    if tg_op='UPDATE' then
      v_identity_unchanged := new.participant_id is not distinct from old.participant_id
        and new.order_item_id is not distinct from old.order_item_id;
      v_reactivating := old.status in ('cancelled','canceled','void','voided');
      -- Sem mudanca de participant_id/order_item_id e sem reativacao a partir
      -- de cancelado/anulado: nenhuma titularidade esta sendo criada ou
      -- alterada nesta atualizacao (ex.: check-in gravando status='used'
      -- sozinho, ou um upsert repetido do mesmo ticket) -- nao ha motivo para
      -- reavaliar unicidade de titular.
      if v_identity_unchanged and not v_reactivating then
        return new;
      end if;
    end if;

    select registration_contact_id into v_contact from public.participants where id=new.participant_id;
    if new.order_item_id is not null then
      select coalesce(v_contact,oi.registration_contact_id,p.registration_contact_id) into v_contact
      from public.order_items oi left join public.participants p on p.id=oi.participant_id where oi.id=new.order_item_id;
    end if;
  else
    select t.id,t.event_id into v_ticket_id,v_event_id from public.tickets t where t.order_item_id=new.id;
    if v_ticket_id is null then return new; end if;
    if new.participant_id is not null then
      select registration_contact_id into v_contact from public.participants where id=new.participant_id;
      new.registration_contact_id:=coalesce(v_contact,new.registration_contact_id);
    else
      v_contact:=new.registration_contact_id;
    end if;
  end if;
  perform public.assert_ticket_holder_contact_available(v_ticket_id,v_event_id,v_contact);
  return new;
end; $$;

commit;
