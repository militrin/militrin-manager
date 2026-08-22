-- Configurador dedicado de Camiseta/Babylook (Etapa 6 do wizard de evento).
--
-- Causa raiz do bug relatado ("Falha ao salvar item do kit" ao adicionar
-- Camiseta): o trigger trg_enforce_explicit_shirt_supply_mode (funcao
-- enforce_explicit_shirt_supply_mode, ja existente) rejeita qualquer
-- event_kit_items com item_type='shirt' AND is_active=true AND
-- shirt_supply_mode IS NULL. O formulario generico EventKitManager (usado
-- para todos os 8 item_type) e a RPC upsert_event_kit_item nunca preenchem
-- shirt_supply_mode -- toda tentativa de salvar uma Camiseta ativa falhava
-- deterministicamente. As duas RPCs abaixo substituem o form generico
-- SOMENTE para item_type='shirt'; os demais tipos (copo, tirante etc.)
-- continuam usando upsert_event_kit_item normalmente.
--
-- Modelo de dados: NENHUMA tabela nova. Reaproveita exatamente as 4 tabelas
-- ja existentes e ja auditadas nesta base:
--   - event_kit_items (1 linha por evento, item_type='shirt', guarda o
--     shirt_supply_mode que faltava);
--   - event_kit_item_variants (1 linha por combinacao modelo+tamanho
--     selecionada -- name=tipo ("Camiseta"/"Babylook"), value=tamanho
--     ("PP".."EXGG"), EXATAMENTE a convencao ja usada pela migration
--     20260857000000_backfill_canonical_shirt_variant_inventory.sql para
--     casar variantes com shirt_inventory, e pela RPC canonica
--     admin_change_ticket_shirt/get_admin_ticket_shirt_options);
--   - event_kit_item_variant_inventory (saldo canonico por variante, usado
--     EXCLUSIVAMENTE pelo fluxo pos-emissao/entrega -- ver comentario da
--     migration 20260857000000: "a entrega ticket-first usa exclusivamente
--     event_kit_item_variant_inventory... nunca le shirt_inventory em tempo
--     de operacao");
--   - shirt_inventory (saldo canonico para TODO o funil de compra: criacao
--     de pedido, edicao de pedido pending E a propria tela /camisetas
--     "Estoque -> Camisetas" -- confirmado por investigacao dedicada em
--     20260844000000_self_service_pending_order_item_shirt.sql: "shirt_inventory
--     ... e a tabela que create_multi_ticket_order_checkout_legacy reserva
--     na criacao do pedido, que a pagina publica de inscricao le pra mostrar
--     disponibilidade, e que a tela administrativa de camisetas usa como
--     fonte").
--
-- Ou seja: o sistema ja tem, de proposito e por decisao arquitetural
-- documentada em rodadas anteriores, DUAS tabelas de saldo canonicas para
-- camiseta -- uma por ETAPA do ciclo de vida (compra vs. entrega), nao um
-- bug de duplicacao. Esta migration nao unifica as duas (isso desfaria uma
-- decisao ja auditada e tornaria o self-service de troca no carrinho orfao
-- -- ver comentario acima). Ela garante que as DUAS fiquem com o MESMO
-- conjunto de combinacoes modelo+tamanho habilitadas para o evento, gravando
-- a mesma selecao nas duas tabelas simultaneamente e nunca sobrescrevendo
-- saldo ja existente (mesmo principio "on conflict do nothing" da
-- migration 20260857000000).
begin;

create or replace function public.get_event_shirt_kit_configuration(p_event_id uuid)
returns table(
  kit_item_id uuid,
  shirt_supply_mode text,
  is_required boolean,
  quantity_per_participant integer,
  variant_id uuid,
  shirt_type text,
  shirt_size text,
  variant_is_active boolean,
  kit_total_quantity integer,
  kit_reserved_quantity integer,
  kit_delivered_quantity integer,
  stock_total_quantity integer,
  stock_reserved_quantity integer,
  stock_delivered_quantity integer
) language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('events.view') then
    raise exception 'Sem permissao para visualizar o evento.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  return query
  select
    eki.id, eki.shirt_supply_mode, eki.is_required, eki.quantity_per_participant,
    v.id, v.name, v.value, v.is_active,
    inv.total_quantity, inv.reserved_quantity, inv.delivered_quantity,
    si.total_quantity, si.reserved_quantity, si.delivered_quantity
  from public.event_kit_items eki
  join public.event_kit_item_variants v on v.kit_item_id = eki.id
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id = eki.id and inv.variant_id = v.id
  left join public.shirt_inventory si on si.event_id = eki.event_id
    and lower(trim(si.shirt_type)) = lower(trim(v.name))
    and upper(trim(si.shirt_size)) = upper(trim(v.value))
  where eki.event_id = p_event_id and eki.item_type = 'shirt'
  order by v.is_active desc, v.name, v.sort_order, v.value;
end; $$;

revoke all on function public.get_event_shirt_kit_configuration(uuid) from public, anon;
grant execute on function public.get_event_shirt_kit_configuration(uuid) to authenticated, service_role;


create or replace function public.save_event_shirt_kit_configuration(
  p_event_id uuid,
  p_supply_mode text,
  p_is_required boolean,
  p_quantity_per_participant integer,
  p_pairs jsonb
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_kit_item_id uuid;
  v_pair jsonb;
  v_shirt_type text;
  v_shirt_size text;
  v_variant_id uuid;
  v_sort_order integer;
  v_kept_variant_ids uuid[] := '{}';
  v_existing record;
  v_kit_inv record;
  v_stock_inv record;
  v_blocked jsonb := '[]'::jsonb;
  v_pair_count integer := 0;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  if p_supply_mode is null or p_supply_mode not in ('stock', 'made_to_order', 'disabled') then
    raise exception 'Modo de fornecimento invalido.';
  end if;

  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  for v_pair in select jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb))
  loop
    v_pair_count := v_pair_count + 1;
  end loop;
  if v_pair_count = 0 then
    raise exception 'Selecione ao menos um tamanho.';
  end if;

  -- Reutiliza a unica linha shirt (se ja existir), nunca cria uma segunda
  -- para o mesmo evento.
  select id into v_kit_item_id
  from public.event_kit_items
  where event_id = p_event_id and item_type = 'shirt'
  limit 1;

  if v_kit_item_id is null then
    insert into public.event_kit_items (
      event_id, name, slug, item_type, quantity_per_participant,
      requires_variant, is_required, is_active, sort_order, shirt_supply_mode
    ) values (
      p_event_id, 'Camiseta', 'camiseta', 'shirt', greatest(coalesce(p_quantity_per_participant, 1), 1),
      true, coalesce(p_is_required, false), true,
      coalesce((select max(sort_order) + 1 from public.event_kit_items where event_id = p_event_id), 0),
      p_supply_mode
    ) returning id into v_kit_item_id;
  else
    update public.event_kit_items
    set shirt_supply_mode = p_supply_mode,
        is_required = coalesce(p_is_required, is_required),
        quantity_per_participant = greatest(coalesce(p_quantity_per_participant, quantity_per_participant), 1),
        is_active = true,
        updated_at = now()
    where id = v_kit_item_id;
  end if;

  -- Materializa cada par selecionado nas 3 tabelas (variante + os 2 saldos
  -- canonicos), nunca sobrescrevendo saldo ja existente.
  for v_pair in select jsonb_array_elements(p_pairs)
  loop
    v_shirt_type := trim(v_pair->>'shirt_type');
    v_shirt_size := upper(trim(v_pair->>'shirt_size'));

    if v_shirt_type not in ('Camiseta', 'Babylook') then
      raise exception 'Modelo de camiseta invalido: %', v_shirt_type;
    end if;
    if v_shirt_size not in ('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG') then
      raise exception 'Tamanho invalido: %', v_shirt_size;
    end if;

    v_sort_order := (case v_shirt_type when 'Camiseta' then 0 else 1 end) * 10
      + array_position(array['PP','P','M','G','GG','EG','EXG','EXGG'], v_shirt_size);

    select id into v_variant_id
    from public.event_kit_item_variants
    where kit_item_id = v_kit_item_id
      and lower(trim(name)) = lower(v_shirt_type)
      and upper(trim(value)) = v_shirt_size;

    if v_variant_id is null then
      insert into public.event_kit_item_variants (kit_item_id, name, value, sort_order, is_active)
      values (v_kit_item_id, v_shirt_type, v_shirt_size, v_sort_order, true)
      returning id into v_variant_id;
    else
      update public.event_kit_item_variants
      set is_active = true, sort_order = v_sort_order
      where id = v_variant_id;
    end if;

    insert into public.event_kit_item_variant_inventory (
      organization_id, event_id, kit_item_id, variant_id, total_quantity, reserved_quantity, delivered_quantity
    ) values (v_event.organization_id, p_event_id, v_kit_item_id, v_variant_id, 0, 0, 0)
    on conflict (kit_item_id, variant_id) do nothing;

    insert into public.shirt_inventory (
      event_id, organization_id, shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity
    ) values (p_event_id, v_event.organization_id, v_shirt_type, v_shirt_size, 0, 0, 0)
    on conflict (event_id, shirt_type, shirt_size) do nothing;

    v_kept_variant_ids := array_append(v_kept_variant_ids, v_variant_id);
  end loop;

  -- Tamanhos desmarcados: remove por completo SOMENTE se nao houver
  -- nenhuma movimentacao real em nenhuma das duas tabelas canonicas
  -- (estoque registrado, reserva ou entrega). Caso contrario, apenas
  -- desativa a variante (some do checkout futuro/edicao pos-emissao via
  -- filtro is_active ja existente em get_admin_ticket_shirt_options) e
  -- preserva os numeros -- nunca perde dado real de pedido/entrega.
  for v_existing in
    select id, name, value
    from public.event_kit_item_variants
    where kit_item_id = v_kit_item_id
      and (array_length(v_kept_variant_ids, 1) is null or not (id = any(v_kept_variant_ids)))
  loop
    select total_quantity, reserved_quantity, delivered_quantity into v_kit_inv
    from public.event_kit_item_variant_inventory
    where kit_item_id = v_kit_item_id and variant_id = v_existing.id;

    select total_quantity, reserved_quantity, delivered_quantity into v_stock_inv
    from public.shirt_inventory
    where event_id = p_event_id
      and lower(trim(shirt_type)) = lower(trim(v_existing.name))
      and upper(trim(shirt_size)) = upper(trim(v_existing.value));

    if coalesce(v_kit_inv.total_quantity, 0) = 0 and coalesce(v_kit_inv.reserved_quantity, 0) = 0
      and coalesce(v_kit_inv.delivered_quantity, 0) = 0
      and coalesce(v_stock_inv.total_quantity, 0) = 0 and coalesce(v_stock_inv.reserved_quantity, 0) = 0
      and coalesce(v_stock_inv.delivered_quantity, 0) = 0 then
      delete from public.shirt_inventory
      where event_id = p_event_id
        and lower(trim(shirt_type)) = lower(trim(v_existing.name))
        and upper(trim(shirt_size)) = upper(trim(v_existing.value));
      delete from public.event_kit_item_variants where id = v_existing.id;
    else
      update public.event_kit_item_variants set is_active = false where id = v_existing.id;
      v_blocked := v_blocked || jsonb_build_object(
        'shirt_type', v_existing.name,
        'shirt_size', v_existing.value,
        'reason', 'Ja existe estoque, reserva ou entrega registrada para este tamanho.'
      );
    end if;
  end loop;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'event_shirt_kit_configuration_saved', 'event_kit_items', v_kit_item_id, p_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_event.organization_id,
      'shirt_supply_mode', p_supply_mode,
      'pairs', p_pairs,
      'blocked_removals', v_blocked
    )
  );

  return jsonb_build_object('kit_item_id', v_kit_item_id, 'blocked_removals', v_blocked);
end; $$;

revoke all on function public.save_event_shirt_kit_configuration(uuid, text, boolean, integer, jsonb) from public, anon;
grant execute on function public.save_event_shirt_kit_configuration(uuid, text, boolean, integer, jsonb) to authenticated, service_role;

commit;
