-- Investigacao pedida: "onde o genero individual de um ingresso existe hoje,
-- depois que o pedido ja foi criado?" Resposta, confirmada lendo o schema e
-- as RPCs de criacao (create_multi_ticket_order_checkout_legacy, ultima
-- versao em 20260842000000_fix_multi_ticket_checkout_required_shirt_per_item.sql):
--
--   NAO EXISTE. order_items nunca teve coluna de genero. O payload de
--   checkout (rpcItems[i].pricing_gender, 'male'|'female', ja validado no
--   frontend antes do submit -- ver src/app/inscricao/actions.ts linha
--   ~1814) chega ate o RPC como v_item_gender, e ali e usado SO pra resolver
--   qual preco buscar via get_registration_pricing_preview -- o resultado
--   (base_amount/discount_amount/final_amount) e gravado em order_items,
--   mas o proprio genero e descartado depois de ter cumprido esse papel. Um
--   order_item so ganha alguma nocao de genero se ownership_status='assigned'
--   E um participant_id for vinculado (so acontece pro item 1, quando
--   p_assign_first_to_buyer=true) -- e mesmo ai, participants.gender e a
--   identidade PESSOAL do titular (usada em relatorios/check-in), nao o
--   pricing_gender usado pra calcular aquele preco especifico; os itens 2..N
--   de um pedido multi-ingresso tipicamente ficam unassigned (participant_id
--   null) e nao tem NENHUMA fonte de genero, nem essa.
--
--   Conclusao: nao ha inferencia segura possivel a partir do estado atual --
--   nem de shirt_type (camiseta e genero sao conceitos independentes, ja
--   documentado em 20260844000000/20260845000000) nem de participants.gender
--   (identidade pessoal, nao pricing, e ausente na maioria dos itens). Editar
--   genero de um ingresso pending exige persistencia propria. Esta e a menor
--   migration correta pra isso: uma coluna nova, populada dai em diante pela
--   propria RPC de criacao (usando o pricing_gender que ela ja recebe e ja
--   usa pra calcular preco -- nunca inventado), mais uma RPC de edicao
--   dedicada que recalcula preco/desconto/total/cupom/PIX ao trocar.
--
--   Pedidos PENDENTES criados ANTES desta migration ficam com pricing_gender
--   NULL (nunca inferido/retroativo) ate serem editados pela primeira vez --
--   a UI trata null como "nao registrado" e exige uma escolha explicita
--   antes de habilitar salvar, nunca assume um valor.
begin;

-- 1) Persistencia: genero de precificacao passa a viver no proprio
-- order_item, canonico e independente de shirt_type/participants.gender.
-- 'male'/'female' pra bater exatamente com CheckoutPricingGender (TS,
-- src/lib/checkout/pricing.ts) e com o payload ja validado no frontend --
-- sem sinonimos aqui: normalizar sinonimos ('masculino'/'feminino'/'m'/'f')
-- e responsabilidade de quem escreve (RPCs abaixo), nao do dado gravado.
alter table public.order_items add column if not exists pricing_gender text;

alter table public.order_items drop constraint if exists order_items_pricing_gender_check;
alter table public.order_items add constraint order_items_pricing_gender_check
  check (pricing_gender is null or pricing_gender in ('male', 'female'));

-- 2) Criacao: create_multi_ticket_order_checkout_legacy passa a gravar o
-- pricing_gender que ela ja resolve por item (v_item_gender, mesma
-- prioridade payload->escalar de sempre) -- nenhuma outra regra desta funcao
-- muda (preco, estoque, camiseta, titularidade continuam identicos a
-- 20260842000000). So normaliza pros dois tokens canonicos antes de gravar,
-- pro caso do fallback escalar (p_gender/p_buyer_gender) chegar em outro
-- formato ('Masculino'/'Feminino', como participants.gender grava).
create or replace function public.create_multi_ticket_order_checkout_legacy(
  p_event_id uuid, p_ticket_category_id uuid, p_gender text, p_quantity integer, p_payment_method text,
  p_coupon_code text default null, p_shirt_type text default null, p_shirt_size text default null,
  p_buyer_full_name text default null, p_buyer_cpf text default null, p_buyer_birth_date date default null,
  p_buyer_gender text default null, p_buyer_phone text default null, p_buyer_email text default null, p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true, p_items jsonb default '[]'::jsonb, p_limit_per_order integer default 10,
  p_notes text default null, p_client_request_id text default null
) returns table(order_id uuid, payment_id uuid, order_number text, payment_status text, reservation_expires_at timestamptz,
  item_count integer, amount numeric, discount_amount numeric, final_amount numeric)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_pricing record;
  v_batch_id uuid;
  v_batch_name text;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_anchor_participant_id uuid;
  v_reservation_expires_at timestamptz;
  v_item_index integer;
  v_item_payload jsonb;
  v_item_shirt_type text;
  v_item_shirt_size text;
  v_item_gender text;
  v_item_pricing_gender text;
  v_item_pricing record;
  v_item_bases numeric[] := '{}'::numeric[];
  v_item_discounts numeric[] := '{}'::numeric[];
  v_item_finals numeric[] := '{}'::numeric[];
  v_ownership_status text;
  v_holder_name text;
  v_holder_email text;
  v_holder_phone text;
  v_status text := 'reserved';
  v_payment_status text := 'pending';
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_total_final numeric := 0;
  v_available_category integer;
  v_unassigned_in_category integer := 0;
  v_required_shirt boolean := false;
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_existing_order public.orders%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sessao autenticada obrigatoria.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_quantity, 0) < 1 then
    raise exception 'Quantidade minima de ingressos: 1.';
  end if;

  if p_limit_per_order is not null and p_quantity > p_limit_per_order then
    raise exception 'Limite maximo por pedido excedido (%).', p_limit_per_order;
  end if;

  if coalesce(trim(coalesce(p_payment_method, '')), '') not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  if coalesce(trim(coalesce(p_buyer_full_name, '')), '') = '' then
    raise exception 'Nome do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_cpf, '')), '') = '' then
    raise exception 'CPF do comprador obrigatorio.';
  end if;

  if p_buyer_birth_date is null then
    raise exception 'Data de nascimento do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_gender, '')), '') = '' then
    raise exception 'Genero do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_phone, '')), '') = '' then
    raise exception 'Telefone do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_city, '')), '') = '' then
    raise exception 'Cidade do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_email, '')), '') = '' then
    raise exception 'E-mail do comprador obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if v_event.registration_open_at is not null and v_event.registration_open_at > now() then
    raise exception 'Inscricoes ainda nao abertas para este evento.';
  end if;

  if v_event.registration_close_at is not null and v_event.registration_close_at < now() then
    raise exception 'Inscricoes encerradas para este evento.';
  end if;

  if p_client_request_id is not null and trim(p_client_request_id) <> '' then
    select * into v_existing_order
    from public.orders
    where user_id = v_user_id
      and client_request_id = trim(p_client_request_id)
    limit 1;

    if found then
      select pay.id, pay.payment_status, pay.expires_at, pay.amount, pay.discount_amount, pay.final_amount
      into v_payment_id, v_payment_status, v_reservation_expires_at, v_total_amount, v_total_discount, v_total_final
      from public.payments pay
      where pay.order_id = v_existing_order.id
      order by pay.created_at desc
      limit 1;

      return query
      select
        v_existing_order.id,
        v_payment_id,
        v_existing_order.order_number,
        coalesce(v_payment_status, 'pending'),
        v_reservation_expires_at,
        coalesce((select count(*)::integer from public.order_items oi where oi.order_id = v_existing_order.id), 0),
        coalesce(v_total_amount, 0),
        coalesce(v_total_discount, 0),
        coalesce(v_total_final, 0);
      return;
    end if;
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    p_gender,
    nullif(trim(coalesce(p_coupon_code, '')), ''),
    p_event_id,
    p_ticket_category_id
  )
  limit 1;

  if v_pricing.batch_id is null then
    raise exception 'Nao foi possivel calcular o preco para a categoria.';
  end if;

  v_batch_id := v_pricing.batch_id;
  v_batch_name := v_pricing.batch_name;

  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  select count(*)::integer into v_unassigned_in_category
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.ticket_category_id = p_ticket_category_id
    and oi.participant_id is null
    and oi.status in ('reserved', 'confirmed');

  if (v_available_category - v_unassigned_in_category) < p_quantity then
    raise exception 'Capacidade da categoria insuficiente para % ingressos.', p_quantity;
  end if;

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
      and eki.is_required = true
  ) into v_required_shirt;

  if v_required_shirt and (coalesce(trim(coalesce(p_shirt_type, '')), '') = '' or coalesce(trim(coalesce(p_shirt_size, '')), '') = '') then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para este modelo e tamanho.';
    end if;

    v_available_stock := coalesce(v_inventory.total_quantity, 0) - coalesce(v_inventory.reserved_quantity, 0) - coalesce(v_inventory.delivered_quantity, 0);
    if v_available_stock < p_quantity then
      raise exception 'Estoque insuficiente para a quantidade solicitada (%).', p_quantity;
    end if;
  end if;

  -- Fix: preco por item, nao mais v_pricing.X (preco do primeiro item, via
  -- p_gender) multiplicado por p_quantity. Cada ingresso resolve o proprio
  -- pricing_gender (mesma prioridade item->scalar da correcao da camiseta) e
  -- chama get_registration_pricing_preview individualmente -- o mesmo RPC
  -- que o frontend ja chama uma vez por item durante o bootstrap de preco.
  -- v_total_amount/discount/final viram a SOMA real das linhas, nao mais uma
  -- multiplicacao que assumia preco uniforme entre ingressos.
  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_item_gender := nullif(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')), '');

    select * into v_item_pricing
    from public.get_registration_pricing_preview(
      v_item_gender,
      nullif(trim(coalesce(p_coupon_code, '')), ''),
      p_event_id,
      p_ticket_category_id
    )
    limit 1;

    if v_item_pricing.batch_id is null then
      raise exception 'Nao foi possivel calcular o preco do ingresso %.', v_item_index;
    end if;

    v_item_bases[v_item_index] := coalesce(v_item_pricing.base_amount, 0);
    v_item_discounts[v_item_index] := coalesce(v_item_pricing.discount_amount, 0);
    v_item_finals[v_item_index] := coalesce(v_item_pricing.final_amount, 0);

    v_total_amount := v_total_amount + v_item_bases[v_item_index];
    v_total_discount := v_total_discount + v_item_discounts[v_item_index];
    v_total_final := v_total_final + v_item_finals[v_item_index];
  end loop;

  v_total_amount := round(v_total_amount, 2);
  v_total_discount := round(v_total_discount, 2);
  v_total_final := round(v_total_final, 2);

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then
    v_payment_status := 'paid';
    v_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_payment_status := 'pending';
    v_status := 'reserved';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  select p.id into v_anchor_participant_id
  from public.participants p
  where p.event_id = p_event_id
    and regexp_replace(coalesce(p.cpf, ''), '\\D', '', 'g') = regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g')
    and p.user_id = v_user_id
  order by p.created_at asc
  limit 1
  for update;

  if v_anchor_participant_id is null then
    insert into public.participants (
      event_id, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size,
      registration_status, notes, reservation_status, reservation_expires_at, batch_id,
      base_amount, discount_amount, final_amount, ticket_category_id, user_id
    ) values (
      p_event_id,
      trim(p_buyer_full_name),
      regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g'),
      p_buyer_birth_date,
      trim(p_buyer_gender),
      regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      lower(trim(p_buyer_email)),
      trim(p_buyer_city),
      coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'),
      coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'Anchor participante do checkout multi-ingressos'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      v_reservation_expires_at,
      v_batch_id,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      p_ticket_category_id,
      v_user_id
    ) returning id into v_anchor_participant_id;
  else
    update public.participants
    set
      full_name = trim(p_buyer_full_name),
      birth_date = p_buyer_birth_date,
      gender = trim(p_buyer_gender),
      phone = regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      email = lower(trim(p_buyer_email)),
      city = trim(p_buyer_city),
      shirt_type = coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), shirt_type),
      shirt_size = coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), shirt_size),
      registration_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_expires_at = v_reservation_expires_at,
      batch_id = v_batch_id,
      base_amount = coalesce(v_pricing.base_amount, 0),
      discount_amount = coalesce(v_pricing.discount_amount, 0),
      final_amount = coalesce(v_pricing.final_amount, 0),
      ticket_category_id = p_ticket_category_id,
      updated_at = now()
    where id = v_anchor_participant_id;
  end if;

  v_order_number := public.generate_order_number();

  insert into public.orders (
    user_id, participant_id, event_id, payment_id, order_number, status,
    base_amount, discount_amount, final_amount, confirmed_at, cancelled_at, client_request_id
  ) values (
    v_user_id,
    v_anchor_participant_id,
    p_event_id,
    null,
    v_order_number,
    case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
    v_total_amount,
    v_total_discount,
    v_total_final,
    case when v_payment_status = 'paid' then now() else null end,
    null,
    nullif(trim(coalesce(p_client_request_id, '')), '')
  ) returning id into v_order_id;

  insert into public.payments (
    participant_id, event_id, amount, discount_amount, final_amount, payment_method,
    payment_status, paid_at, expires_at, order_id
  ) values (
    v_anchor_participant_id,
    p_event_id,
    v_total_amount,
    v_total_discount,
    v_total_final,
    trim(p_payment_method),
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    v_reservation_expires_at,
    v_order_id
  ) returning id into v_payment_id;

  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    -- Fix (20260840000000): cada ingresso grava a PROPRIA camiseta/tamanho
    -- (v_item_payload), nao mais o parametro escalar de topo replicado pra
    -- todo o loop. O scalar p_shirt_type/p_shirt_size continua servindo de
    -- fallback quando o item nao especifica (fluxo de ingresso unico, que
    -- nunca populou p_items[i].shirt_type).
    v_item_shirt_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_item_shirt_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    -- Fix (20260846000000): mesma prioridade item->escalar ja usada pro
    -- calculo de preco (primeiro loop, v_item_gender) -- so que aqui o
    -- resultado e normalizado pros dois tokens canonicos ('male'/'female')
    -- e GRAVADO em order_items.pricing_gender, nunca descartado depois de
    -- calcular o preco. Um valor em formato inesperado vira null (nunca um
    -- terceiro token fora do check constraint) -- consistente com "nao
    -- inferir silenciosamente": se nao da pra reconhecer o genero, fica
    -- nao registrado, nao adivinhado.
    v_item_gender := lower(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')));
    v_item_pricing_gender := case
      when v_item_gender in ('female', 'feminino', 'f') then 'female'
      when v_item_gender in ('male', 'masculino', 'm') then 'male'
      else null
    end;

    -- Fix (20260842000000): a checagem de "camiseta obrigatoria" antes deste
    -- loop so olhava pro item 1 (p_shirt_type/p_shirt_size escalares). Um
    -- payload com o item 1 preenchido e os itens 2..N sem shirt_type/
    -- shirt_size passava por ali sem erro e cada item 2..N nascia com o
    -- fallback pro escalar (bug 20260840000000) OU, se nem o escalar
    -- estivesse preenchido, com shirt_type/shirt_size null -- nunca
    -- rejeitado, mesmo o evento exigindo camiseta pra todo ingresso. Agora,
    -- pra evento com camiseta obrigatoria, CADA item resolvido sem
    -- shirt_type ou sem shirt_size aborta a transacao inteira (orders/
    -- payments ja inseridos nesta chamada sao desfeitos automaticamente),
    -- identificando o ingresso especifico na mensagem.
    if v_required_shirt and (v_item_shirt_type is null or v_item_shirt_size is null) then
      raise exception 'Camiseta obrigatoria para o ingresso %.', v_item_index;
    end if;

    v_ownership_status := lower(trim(coalesce(v_item_payload ->> 'ownership_status', case when p_assign_first_to_buyer and v_item_index = 1 then 'assigned' else 'unassigned' end)));
    v_holder_name := nullif(trim(coalesce(v_item_payload ->> 'holder_full_name', '')), '');
    v_holder_email := nullif(lower(trim(coalesce(v_item_payload ->> 'holder_email', ''))), '');
    v_holder_phone := nullif(regexp_replace(coalesce(v_item_payload ->> 'holder_phone', ''), '\\D', '', 'g'), '');

    if v_ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled') then
      v_ownership_status := 'unassigned';
    end if;

    if v_ownership_status = 'assigned' and not (p_assign_first_to_buyer and v_item_index = 1) then
      v_ownership_status := 'unassigned';
    end if;

    insert into public.order_items (
      order_id, event_id, participant_id, ownership_status, ticket_category_id, batch_id,
      shirt_type, shirt_size, pricing_gender, quantity, unit_price, discount_amount, final_amount, status,
      reservation_expires_at, item_position, holder_full_name, holder_email, holder_phone
    ) values (
      v_order_id,
      p_event_id,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then v_anchor_participant_id else null end,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then 'assigned' else 'unassigned' end,
      p_ticket_category_id,
      v_batch_id,
      v_item_shirt_type,
      v_item_shirt_size,
      v_item_pricing_gender,
      1,
      v_item_bases[v_item_index],
      v_item_discounts[v_item_index],
      v_item_finals[v_item_index],
      v_status,
      v_reservation_expires_at,
      v_item_index,
      v_holder_name,
      v_holder_email,
      v_holder_phone
    );
  end loop;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + p_quantity,
        updated_at = now()
    where id = v_inventory.id;

    insert into public.inventory_movements (
      event_id, inventory_id, movement_type, quantity, notes
    ) values (
      p_event_id,
      v_inventory.id,
      'adjustment',
      -p_quantity,
      format('Reserva checkout multi (%s) pedido %s.', p_quantity, v_order_number)
    );
  end if;

  if coalesce(v_event.kit_enabled, false) then
    insert into public.participant_kit_items (
      participant_id, event_id, kit_item_id, variant_data, quantity, status
    )
    select
      v_anchor_participant_id,
      p_event_id,
      eki.id,
      case
        when eki.item_type = 'shirt' then jsonb_build_object('shirt_type', coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'), 'shirt_size', coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'))
        else null
      end,
      eki.quantity_per_participant,
      case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.is_active = true
    on conflict (order_item_id, kit_item_id)
    do update set
      quantity = excluded.quantity,
      status = excluded.status,
      variant_data = excluded.variant_data;
  end if;

  if v_payment_status = 'paid' then
    perform public.confirm_order_payment_and_issue_tickets(v_order_id);
  end if;

  return query
  select
    v_order_id,
    v_payment_id,
    v_order_number,
    v_payment_status,
    v_reservation_expires_at,
    p_quantity,
    v_total_amount,
    v_total_discount,
    v_total_final;
end;
$$;

-- 3) Leitura: get_cart_order_details (fonte canonica ja usada por CartStep,
-- EditTicketsStep e a pagina de detalhe do pedido) passa a devolver
-- pricing_gender por item -- superset estrito da versao anterior
-- (20260837000000_unified_order_payment_snapshot.sql), nenhum outro campo
-- muda.
create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_event public.events%rowtype;
  v_payment public.payments%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status, 'quantity', oi.quantity,
    'item_position', oi.item_position, 'ownership_status', oi.ownership_status,
    'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name, 'batch_name', rb.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'pricing_gender', oi.pricing_gender,
    'holder_full_name', oi.holder_full_name,
    'participant_id', oi.participant_id, 'participant_name', part.full_name,
    'ticket_id', t.id, 'ticket_status', t.status, 'ticket_token', t.token,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by case oi.item_kind when 'ticket' then 0 else 1 end, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  left join public.participants part on part.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'order_status', v_order.status,
    'event_id', v_order.event_id, 'event_name', v_event.name,
    'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_payment.amount, 'discount_amount', v_payment.discount_amount,
      'final_amount', v_payment.final_amount, 'payment_method', v_payment.payment_method, 'payment_status', v_payment.payment_status,
      'pix_code', v_payment.pix_code, 'pix_qrcode', v_payment.pix_qrcode, 'gateway_payment_id', v_payment.gateway_payment_id,
      'expires_at', v_payment.expires_at, 'paid_at', v_payment.paid_at
    ) end,
    'items', v_items
  );
end; $$;

-- 4) Edicao: change_pending_order_item_gender -- mesmo contrato de
-- ownership/pending/pertencimento das outras RPCs de edicao self-service
-- (change_pending_order_item_shirt, 20260844000000/20260845000000), mas
-- troca pricing_gender em vez de shirt_type/shirt_size. Diferenca essencial:
-- genero AFETA preco neste schema (male_price/female_price por lote), entao
-- esta RPC recalcula unit_price do item usando o MESMO lote/categoria ja
-- travado nele (registration_batches.male_price/female_price via
-- oi.batch_id) -- nunca re-resolve "o lote atual" (que pode ter avancado
-- desde a compra), preservando a mesma janela de preco que o comprador ja
-- garantiu. apply_cart_coupon no final recalcula desconto/subtotal/total do
-- PEDIDO inteiro e invalida o PIX se o total mudar (mesmo ponto unico
-- reusado por toda mutacao de carrinho desde 20260843000000) -- exatamente
-- o que muda ao trocar genero, shirt_type nunca entra nesta conta.
create or replace function public.change_pending_order_item_gender(
  p_order_id uuid, p_order_item_id uuid, p_gender text
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_batch public.registration_batches%rowtype;
  v_raw_gender text := lower(trim(coalesce(p_gender, '')));
  v_new_gender text;
  v_new_unit_price numeric;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  v_new_gender := case
    when v_raw_gender in ('female', 'feminino', 'f') then 'female'
    when v_raw_gender in ('male', 'masculino', 'm') then 'male'
    else null
  end;
  if v_new_gender is null then
    raise exception 'Genero invalido. Use Masculino ou Feminino.';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  if v_item.order_id is distinct from p_order_id then
    raise exception 'Item nao pertence a este pedido.';
  end if;
  if v_item.item_kind <> 'ticket' then
    raise exception 'Somente ingressos tem genero editavel por aqui.';
  end if;
  if v_item.status in ('cancelled','expired','refunded','transferred') then
    raise exception 'Item nao esta mais ativo neste pedido.';
  end if;

  select * into v_order from public.orders where id = v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta mais no carrinho.';
  end if;

  select * into v_payment from public.payments where order_id = v_order.id order by created_at desc limit 1 for update;
  if found then
    if v_payment.payment_status <> 'pending' then
      raise exception 'Pedido nao esta mais no carrinho.';
    end if;
    if v_payment.expires_at is not null and v_payment.expires_at <= now() then
      raise exception 'O prazo de reserva deste pedido ja expirou.';
    end if;
  end if;

  -- Sem mudanca real: no-op idempotente, nunca recalcula preco a toa.
  if v_new_gender = v_item.pricing_gender then
    select jsonb_build_object(
      'order_id', v_order.id, 'order_item_id', p_order_item_id,
      'pricing_gender', v_item.pricing_gender, 'changed', false
    ) into v_result;
    return v_result;
  end if;

  if v_item.batch_id is null then
    raise exception 'Nao foi possivel determinar o lote deste ingresso para recalcular o preco.';
  end if;

  select * into v_batch from public.registration_batches where id = v_item.batch_id for update;
  if not found then
    raise exception 'Lote do ingresso nao encontrado para recalcular o preco.';
  end if;

  v_new_unit_price := round(case when v_new_gender = 'female' then v_batch.female_price else v_batch.male_price end, 2);

  update public.order_items
  set pricing_gender = v_new_gender, unit_price = v_new_unit_price, updated_at = now()
  where id = p_order_item_id;

  -- Recalcula discount_amount/final_amount deste item e de todo o pedido
  -- (base_amount/discount_amount/final_amount) a partir do unit_price novo,
  -- reaplica o cupom atual e invalida o PIX se o total tiver mudado -- mesmo
  -- ponto unico ja usado por toda mutacao de carrinho.
  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_pricing_gender_changed', 'order_items', p_order_item_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'previous_pricing_gender', v_item.pricing_gender, 'new_pricing_gender', v_new_gender,
    'previous_unit_price', v_item.unit_price, 'new_unit_price', v_new_unit_price));

  select jsonb_build_object(
    'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'pricing_gender', v_new_gender, 'changed', true
  ) into v_result;
  return v_result;
end; $$;

revoke all on function public.change_pending_order_item_gender(uuid, uuid, text) from public, anon;
grant execute on function public.change_pending_order_item_gender(uuid, uuid, text) to authenticated;

commit;
