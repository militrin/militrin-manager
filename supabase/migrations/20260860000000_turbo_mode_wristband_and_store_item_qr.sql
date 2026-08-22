-- Modo Turbo (Central de Operacoes): leitor unico continuo pra ingresso
-- (ficha enxuta -> pulseira -> entrega+checkin) e produto de loja (QR por
-- item -> confirmar entrega).
--
-- INVESTIGACAO PREVIA (nada abaixo duplica RPC/tabela ja existente):
--   - link_wristband_to_ticket, deliver_ticket_full_kit, checkin_ticket_entry
--     e deliver_items_and_checkin (migration 20260848000000) ja cobrem
--     ingresso+kit+checkin+pulseira OBRIGATORIA (so vincula pulseira dentro
--     da propria transacao quando o evento EXIGE pulseira pro check-in/kit
--     e o ingresso ainda nao tem uma). O Turbo precisa vincular a pulseira
--     escaneada MESMO quando o evento usa pulseira mas nao a torna
--     obrigatoria (wristband_enabled=true, wristband_required_for_*=false)
--     -- e exatamente o caso que o gate condicional das RPCs existentes nao
--     cobre. Por isso a secao 1 abaixo cria uma unica RPC nova que faz esse
--     vinculo incondicional (quando ha codigo e o ingresso ainda nao tem
--     pulseira ativa) e DEPOIS delega 100% da entrega/checkin pras RPCs
--     originais (perform/select, mesma transacao) -- nenhuma logica de
--     estoque/validacao e duplicada aqui.
--   - deliver_store_order_item (migration 20260854000000) ja entrega item de
--     loja com todas as validacoes (permissao, organizacao, status,
--     estoque, idempotencia). Nao e alterada. So faltava uma forma de
--     identificar um store_order_item individual por QR -- ate aqui so
--     existia QR por PEDIDO inteiro (order_number, usado em
--     /api/loja/pedidos/[id]/qrcode). Secao 2 adiciona uma coluna de token
--     opaco por item (mesmo espirito de tickets.token), pra impressao futura
--     e leitura pelo Turbo.
begin;

-- ============================================================
-- 1. deliver_items_checkin_and_link_wristband -- vincula a pulseira
--    escaneada e SEMPRE delega pra deliver_ticket_full_kit +
--    checkin_ticket_entry na mesma transacao. Erro em qualquer etapa desfaz
--    tudo, inclusive o vinculo de pulseira recem-criado (mesmo padrao ja
--    documentado em deliver_items_and_checkin). Exige kits.deliver E
--    checkin.scan incondicionalmente (mesma convencao ja usada por
--    deliver_items_and_checkin, inclusive pra eventos sem kit configurado --
--    o botao "Entregar + check-in" da tela normal ja segue essa mesma regra
--    hoje).
--
--    CORRECAO (silencio ao reler pulseira ja vinculada): a versao original
--    so chamava link_wristband_to_ticket quando o ingresso AINDA NAO tinha
--    nenhuma pulseira ativa ("if not v_has_wristband"). Isso pulava por
--    completo a validacao/mensagem da funcao pra qualquer cenario em que o
--    ingresso ja tivesse alguma pulseira ativa (ex.: race condition entre
--    duas operacoes Turbo simultaneas no mesmo ingresso) -- o codigo
--    escaneado nunca era conferido contra o que estava de fato gravado, e o
--    fluxo so caia direto em checkin_ticket_entry, que levanta um erro
--    generico ("ingresso ja foi utilizado") sem nenhuma mencao a pulseira.
--    Agora SEMPRE chama link_wristband_to_ticket quando ha codigo (ela ja e
--    idempotente: mesmo ingresso+mesmo codigo devolve already_linked=true
--    sem erro; outro ingresso ou pulseira diferente ja ativa neste ingresso
--    levantam excecao clara, sem alteracao aqui). Quando already_linked=true
--    E o ingresso ja estava concluido (status='used'), levanta um erro
--    CODIFICADO especifico (mesmo padrao WRISTBAND_REQUIRED/
--    SHIRT_OUT_OF_STOCK) em vez de deixar cair no erro generico de
--    checkin_ticket_entry -- e tambem NUNCA tenta reprocessar entrega/
--    checkin nesse caso.
-- ============================================================
create or replace function public.deliver_items_checkin_and_link_wristband(p_ticket_id uuid, p_wristband_code text default null)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ticket public.tickets%rowtype;
  v_event public.events%rowtype;
  v_link_result jsonb;
  v_already_linked boolean := false;
  v_code text := nullif(trim(coalesce(p_wristband_code, '')), '');
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then
    raise exception 'Sem permissao para entrega e check-in.';
  end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso.';
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;

  if coalesce(v_event.wristband_enabled, false) and v_code is not null then
    if not public.current_user_has_permission('wristbands.link') then
      raise exception 'Sem permissao para vincular pulseira.';
    end if;
    -- Sempre valida/vincula -- nunca pula essa chamada so porque o ingresso
    -- ja tem alguma pulseira ativa (ver comentario acima).
    v_link_result := public.link_wristband_to_ticket(v_ticket.id, v_code);
    v_already_linked := coalesce((v_link_result ->> 'already_linked')::boolean, false);
  end if;

  if v_already_linked and v_ticket.status = 'used' then
    raise exception using errcode = 'P0001', message = 'WRISTBAND_ALREADY_LINKED_SAME_TICKET',
      detail = jsonb_build_object('code', 'WRISTBAND_ALREADY_LINKED_SAME_TICKET', 'message', 'Esta pulseira já está vinculada a este ingresso.')::text;
  end if;

  perform public.deliver_ticket_full_kit(p_ticket_id, p_wristband_code);
  if public.checkin_ticket_entry(p_ticket_id, p_wristband_code) is distinct from true then
    raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.';
  end if;

  return true;
end;
$$;

revoke all on function public.deliver_items_checkin_and_link_wristband(uuid, text) from public, anon;
grant execute on function public.deliver_items_checkin_and_link_wristband(uuid, text) to authenticated, service_role;

-- ============================================================
-- 2. store_order_items.qr_token -- token opaco por item (nao por pedido),
--    pra impressao/exibicao futura e leitura pelo Modo Turbo. Backfill dos
--    itens existentes antes do NOT NULL; DEFAULT cobre todo insert futuro
--    (create_store_order/admin_grant_store_item ja no listam qr_token na
--    lista de colunas, entao o DEFAULT dispara sem precisar tocar nenhuma
--    dessas RPCs).
-- ============================================================
alter table public.store_order_items
  add column if not exists qr_token text;

update public.store_order_items
  set qr_token = 'ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  where qr_token is null;

alter table public.store_order_items
  alter column qr_token set default ('ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)));

alter table public.store_order_items
  alter column qr_token set not null;

create unique index if not exists store_order_items_qr_token_key on public.store_order_items (qr_token);

commit;
