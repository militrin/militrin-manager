-- Bug reportado no teste manual ponta a ponta: clicar em "Entregar + check-in"
-- (ingresso com titular ja definido, kit pendente, check-in pendente) falhava
-- com o erro tecnico HOLDER_ALREADY_HAS_TICKET_FOR_EVENT exibido cru pro
-- operador, sem modal, sem mensagem amigavel.
--
-- CAUSA RAIZ (confirmada por leitura do codigo + consulta somente-leitura no
-- banco linkado, nao por tentativa):
--   deliver_items_and_checkin -> checkin_ticket_entry executa
--   `update public.tickets set status='used', used_at=now() where id=...`.
--   O trigger enforce_ticket_holder_contact_uniqueness (definido em
--   20260815001914_remote_schema.sql, ainda vigente sem alteracao) e
--   `before insert or update of participant_id, event_id, status,
--   order_item_id on public.tickets` -- ou seja, dispara em QUALQUER update
--   que toque a coluna status, mesmo quando participant_id/order_item_id nao
--   mudam nem um pouco. A funcao trg_enforce_ticket_holder_contact_uniqueness
--   entao chama assert_ticket_holder_contact_available, que reavalia se este
--   titular ja possui OUTRO ingresso ativo no mesmo evento.
--
--   Consulta direta ao banco linkado (select participants/order_items/tickets
--   por full_name ilike 'Teste Importa%F1%') confirmou que a causa e real, nao
--   hipotetica: o participante "Teste Importação F1"
--   (id e87b532a-0017-481b-b9e0-1d8bae2ee871, registration_contact_id
--   bfc527b0-9083-4644-9d4a-d5b36983aae8) e titular de DOIS tickets distintos
--   com status='active' no MESMO evento (533efbf0-7063-4f88-9c5b-850befeb4b29
--   e 6345e220-cd3d-486e-aad9-915f0a09b8f5) -- dado legado/importado
--   pre-existente, que nunca tinha sido bloqueado ate agora porque nenhuma
--   operacao anterior sobre esses tickets havia tocado a coluna status desde
--   que o trigger de unicidade existe.
--
--   Ou seja: a regra "1 titular por pessoa por evento" esta correta e
--   continua detectando um problema real de dados. O BUG e que ela estava
--   sendo reavaliada durante check-in/entrega de kit -- operacoes que NUNCA
--   reatribuem titularidade (nao escrevem participant_id nem order_item_id em
--   tickets) -- em vez de ficar restrita a transicoes que de fato criam ou
--   alteram o vinculo de titularidade.
--
-- CORRECAO (cirurgica, na trigger function, nao na regra): a reavaliacao de
-- unicidade em public.tickets passa a rodar somente quando:
--   (a) INSERT (novo ticket sempre precisa ser validado), OU
--   (b) participant_id ou order_item_id realmente mudaram (reatribuicao real
--       de titular), OU
--   (c) o ticket esta sendo REATIVADO a partir de um status
--       cancelado/anulado (OLD.status estava em
--       cancelled/canceled/void/voided e o NEW.status nao esta) -- e
--       exatamente o cenario que motivou incluir "status" na lista de
--       colunas observadas originalmente: um ticket cancelado fica de fora da
--       checagem de "outro ingresso ativo"; ao ser reativado, ele volta a
--       contar e precisa ser revalidado.
-- Uma simples transicao de status entre estados nao-cancelados (ex.:
-- active -> used, feita por check-in) NAO reatribui titularidade e portanto
-- NAO reexecuta mais a checagem -- o dado duplicado legado permanece
-- registrado (nao foi alterado nem escondido) e continua bloqueando qualquer
-- tentativa futura de REATRIBUIR ou REATIVAR titularidade para este contato
-- neste evento, exatamente como antes.
--
-- O trigger em public.order_items (enforce_order_item_holder_contact_uniqueness,
-- que observa participant_id/registration_contact_id/event_id, sem "status")
-- nao e afetado por este bug -- nenhuma das RPCs de entrega/check-in escreve
-- em order_items -- e nao precisa de alteracao.
begin;

create or replace function public.trg_enforce_ticket_holder_contact_uniqueness()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_contact uuid; v_ticket_id uuid; v_event_id uuid; v_identity_unchanged boolean; v_reactivating boolean;
begin
  if tg_table_name='tickets' then
    v_ticket_id:=new.id; v_event_id:=new.event_id;
    if new.status in ('cancelled','canceled','void','voided') then return new; end if;

    if tg_op='UPDATE' then
      v_identity_unchanged := new.participant_id is not distinct from old.participant_id
        and new.order_item_id is not distinct from old.order_item_id;
      v_reactivating := old.status in ('cancelled','canceled','void','voided');
      -- Sem mudanca de participant_id/order_item_id e sem reativacao a partir
      -- de cancelado/anulado: nenhuma titularidade esta sendo criada ou
      -- alterada nesta atualizacao (ex.: check-in gravando status='used'
      -- sozinho) -- nao ha motivo para reavaliar unicidade de titular.
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
