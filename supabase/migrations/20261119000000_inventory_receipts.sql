-- Version 20261119000000
-- Entradas fisicas de camisetas (receipt) separadas do ledger tecnico.
-- inventory_movements continua sendo trilha; receipts sao o historico operacional.
-- Backfill so liga purchases historicos comprovados. Nao altera total_quantity.
-- Nao aplicar remotamente neste lote.

begin;

create table if not exists public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  event_id uuid not null references public.events(id),
  description text not null,
  ordered_at date,
  received_at date not null,
  supplier text,
  notes text,
  origin text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  status text not null default 'posted',
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  idempotency_key uuid not null,
  constraint inventory_receipts_description_check check (length(trim(description)) > 0),
  constraint inventory_receipts_status_check check (status in ('posted', 'reversed')),
  constraint inventory_receipts_origin_check check (origin in ('live', 'historical_backfill')),
  constraint inventory_receipts_created_by_origin_check check (
    origin <> 'live' or created_by is not null
  ),
  constraint inventory_receipts_reversal_check check (
    (status = 'posted' and reversed_at is null and reversed_by is null and reversal_reason is null)
    or (status = 'reversed' and reversed_at is not null and reversed_by is not null)
  ),
  constraint inventory_receipts_org_idempotency_key unique (organization_id, idempotency_key)
);

create table if not exists public.inventory_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.inventory_receipts(id),
  organization_id uuid not null references public.organizations(id),
  inventory_id uuid not null references public.shirt_inventory(id),
  quantity integer not null,
  created_at timestamptz not null default now(),
  constraint inventory_receipt_items_quantity_check check (quantity > 0),
  constraint inventory_receipt_items_receipt_inventory_key unique (receipt_id, inventory_id)
);

alter table public.inventory_movements
  add column if not exists receipt_id uuid references public.inventory_receipts(id);

create index if not exists idx_inventory_receipts_event_received
  on public.inventory_receipts (event_id, received_at desc, created_at desc);
create index if not exists idx_inventory_receipts_org_event
  on public.inventory_receipts (organization_id, event_id);
create index if not exists idx_inventory_receipt_items_receipt
  on public.inventory_receipt_items (receipt_id);
create index if not exists idx_inventory_receipt_items_inventory
  on public.inventory_receipt_items (inventory_id);
create index if not exists idx_inventory_movements_receipt_id
  on public.inventory_movements (receipt_id)
  where receipt_id is not null;

comment on table public.inventory_receipts is
  'Entrada fisica/encomenda de camisetas. Historico operacional do evento; nao substitui o ledger.';
comment on column public.inventory_receipts.origin is
  'live = entrada nova via RPC (created_by=auth.uid). historical_backfill = legado sem operador.';
comment on column public.inventory_receipts.idempotency_key is
  'UUID gerado pelo client. UNIQUE por organizacao para double-click/retry.';
comment on table public.inventory_receipt_items is
  'Composicao de uma entrada. UNIQUE(receipt_id, inventory_id).';
comment on column public.inventory_movements.receipt_id is
  'Vinculo opcional com a entrada administrativa. Movements tecnicos permanecem null.';

alter table public.inventory_receipts enable row level security;
alter table public.inventory_receipt_items enable row level security;

drop policy if exists inventory_receipts_rbac_select on public.inventory_receipts;
create policy inventory_receipts_rbac_select
  on public.inventory_receipts
  for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'inventory.view')
        or public.resolve_user_permission(auth.uid(), 'inventory.view_history')
        or public.resolve_user_permission(auth.uid(), 'inventory.adjust')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

drop policy if exists inventory_receipt_items_rbac_select on public.inventory_receipt_items;
create policy inventory_receipt_items_rbac_select
  on public.inventory_receipt_items
  for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'inventory.view')
        or public.resolve_user_permission(auth.uid(), 'inventory.view_history')
        or public.resolve_user_permission(auth.uid(), 'inventory.adjust')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

revoke all on table public.inventory_receipts from public, anon;
revoke all on table public.inventory_receipt_items from public, anon;
grant select on table public.inventory_receipts to authenticated;
grant select on table public.inventory_receipt_items to authenticated;
grant all on table public.inventory_receipts to service_role;
grant all on table public.inventory_receipt_items to service_role;

create or replace function public.create_inventory_receipt(
  p_event_id uuid,
  p_description text,
  p_received_at date,
  p_items jsonb,
  p_idempotency_key uuid,
  p_ordered_at date default null,
  p_supplier text default null,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_supplier text := nullif(trim(coalesce(p_supplier, '')), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_receipt_id uuid;
  v_existing uuid;
  v_item record;
  v_inventory public.shirt_inventory%rowtype;
  v_previous_total integer;
  v_new_total integer;
  v_item_count integer := 0;
  v_total_qty integer := 0;
begin
  if v_actor is null then
    raise exception 'Usuario nao autenticado.';
  end if;
  if not public.current_user_has_permission('inventory.adjust') then
    raise exception 'Sem permissao para registrar entrada de estoque.';
  end if;
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;
  if v_description is null then
    raise exception 'Descricao da entrada e obrigatoria.';
  end if;
  if p_received_at is null then
    raise exception 'Data de recebimento e obrigatoria.';
  end if;
  if p_received_at > (timezone('America/Sao_Paulo', now()))::date then
    raise exception 'Data de recebimento nao pode ser futura.';
  end if;
  if p_ordered_at is not null and p_ordered_at > p_received_at then
    raise exception 'Data do pedido nao pode ser posterior ao recebimento.';
  end if;
  if p_idempotency_key is null then
    raise exception 'Chave de idempotencia obrigatoria.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Itens da entrada invalidos.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) elem
    where elem->>'inventory_id' is null
       or jsonb_typeof(elem->'quantity') is distinct from 'number'
       or (elem->>'quantity')::numeric <> trunc((elem->>'quantity')::numeric)
       or (elem->>'quantity')::numeric <= 0
       or (elem->>'quantity')::numeric > 2147483647
  ) then
    raise exception 'Quantidade deve ser um inteiro maior que zero.';
  end if;

  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_event.organization_id::text || ':' || p_idempotency_key::text));

  select id into v_existing
  from public.inventory_receipts
  where organization_id = v_event.organization_id
    and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(inventory_id uuid, quantity integer)
    group by inventory_id
    having count(*) > 1
  ) then
    raise exception 'Item duplicado na entrada.';
  end if;

  insert into public.inventory_receipts (
    organization_id, event_id, description, ordered_at, received_at, supplier, notes,
    origin, created_by, status, idempotency_key
  ) values (
    v_event.organization_id, p_event_id, v_description, p_ordered_at, p_received_at, v_supplier, v_notes,
    'live', v_actor, 'posted', p_idempotency_key
  )
  on conflict on constraint inventory_receipts_org_idempotency_key do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    select id into v_receipt_id
    from public.inventory_receipts
    where organization_id = v_event.organization_id
      and idempotency_key = p_idempotency_key;
    return v_receipt_id;
  end if;

  for v_item in
    select x.inventory_id, x.quantity
    from jsonb_to_recordset(p_items) as x(inventory_id uuid, quantity integer)
  loop
    if v_item.inventory_id is null then
      raise exception 'Linha de estoque obrigatoria.';
    end if;
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Quantidade deve ser maior que zero.';
    end if;
    if v_total_qty > 2147483647 - v_item.quantity then
      raise exception 'Quantidade total excede o limite.';
    end if;

    select * into v_inventory
    from public.shirt_inventory
    where id = v_item.inventory_id
    for update;

    if not found then
      raise exception 'Linha de estoque nao encontrada para o evento informado.';
    end if;
    if v_inventory.event_id is distinct from p_event_id then
      raise exception 'Linha de estoque nao encontrada para o evento informado.';
    end if;
    if v_inventory.organization_id is distinct from v_event.organization_id then
      raise exception 'Linha de estoque nao pertence a organizacao do evento.';
    end if;
    if v_inventory.total_quantity > 2147483647 - v_item.quantity then
      raise exception 'Quantidade total excede o limite.';
    end if;

    v_previous_total := v_inventory.total_quantity;

    update public.shirt_inventory
    set total_quantity = total_quantity + v_item.quantity,
        updated_at = now()
    where id = v_inventory.id
    returning total_quantity into v_new_total;

    insert into public.inventory_receipt_items (
      receipt_id, organization_id, inventory_id, quantity
    ) values (
      v_receipt_id, v_event.organization_id, v_inventory.id, v_item.quantity
    );

    insert into public.inventory_movements (
      event_id, inventory_id, movement_type, quantity, notes, receipt_id
    ) values (
      p_event_id, v_inventory.id, 'purchase', v_item.quantity, v_description, v_receipt_id
    );

    insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
    values (
      'inventory_quantity_added',
      'shirt_inventory',
      v_inventory.id,
      p_event_id,
      jsonb_build_object(
        'actor_user_id', v_actor,
        'movement_type', 'purchase',
        'quantity', v_item.quantity,
        'notes', v_description,
        'previous_total', v_previous_total,
        'new_total', v_new_total,
        'shirt_type', v_inventory.shirt_type,
        'shirt_size', v_inventory.shirt_size,
        'receipt_id', v_receipt_id
      )
    );

    v_item_count := v_item_count + 1;
    v_total_qty := v_total_qty + v_item.quantity;
  end loop;

  if v_item_count = 0 then
    raise exception 'Informe ao menos uma quantidade maior que zero.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'inventory_receipt_created',
    'inventory_receipts',
    v_receipt_id,
    p_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_event.organization_id,
      'description', v_description,
      'ordered_at', p_ordered_at,
      'received_at', p_received_at,
      'item_count', v_item_count,
      'total_quantity', v_total_qty,
      'idempotency_key', p_idempotency_key
    )
  );

  return v_receipt_id;
end;
$$;

create or replace function public.list_event_inventory_receipts(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'Usuario nao autenticado.';
  end if;
  if not public.current_user_has_permission('inventory.view_history') then
    raise exception 'Sem permissao para ver historico de entradas.';
  end if;
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;

  select coalesce(jsonb_agg(receipt_row order by received_at desc, created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      r.received_at,
      r.created_at,
      jsonb_build_object(
        'id', r.id,
        'description', r.description,
        'ordered_at', r.ordered_at,
        'received_at', r.received_at,
        'supplier', r.supplier,
        'notes', r.notes,
        'status', r.status,
        'origin', r.origin,
        'created_by', r.created_by,
        'created_at', r.created_at,
        'total_quantity', coalesce((
          select sum(i.quantity)::integer from public.inventory_receipt_items i where i.receipt_id = r.id
        ), 0),
        'items', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'inventory_id', i.inventory_id,
              'shirt_type', si.shirt_type,
              'shirt_size', si.shirt_size,
              'quantity', i.quantity
            )
            order by si.shirt_type, si.shirt_size
          )
          from public.inventory_receipt_items i
          join public.shirt_inventory si on si.id = i.inventory_id
          where i.receipt_id = r.id
        ), '[]'::jsonb)
      ) as receipt_row
    from public.inventory_receipts r
    where r.event_id = p_event_id
      and r.organization_id = v_event.organization_id
  ) receipts;

  return v_result;
end;
$$;

revoke all on function public.create_inventory_receipt(uuid, text, date, jsonb, uuid, date, text, text) from public, anon;
grant execute on function public.create_inventory_receipt(uuid, text, date, jsonb, uuid, date, text, text) to authenticated, service_role;

revoke all on function public.list_event_inventory_receipts(uuid) from public, anon;
grant execute on function public.list_event_inventory_receipts(uuid) to authenticated, service_role;

-- Backfill historico: so os 3 grupos comprovados por notes exata.
-- Se o evento nao tiver esses purchases (dev vazio), nao cria receipts.
-- Se tiver algum mas guards falharem, aborta a migration inteira.
create or replace function public._backfill_historical_inventory_receipt(
  p_event_id uuid,
  p_organization_id uuid,
  p_notes text,
  p_description text,
  p_ordered_at date,
  p_received_at date,
  p_idempotency_key uuid,
  p_expected_count integer,
  p_expected_qty integer,
  p_expected_composition jsonb
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer;
  v_qty integer;
  v_linked integer;
  v_receipt_id uuid;
  v_existing uuid;
  v_created_at timestamptz;
  v_actual jsonb;
  v_snapshot jsonb;
begin
  select count(*)::integer, coalesce(sum(quantity), 0)::integer, min(created_at)
  into v_count, v_qty, v_created_at
  from public.inventory_movements
  where event_id = p_event_id
    and movement_type = 'purchase'
    and notes = p_notes;

  if v_count <> p_expected_count then
    raise exception 'Backfill abortado: % esperava % movimentos, encontrou %.', p_notes, p_expected_count, v_count;
  end if;
  if v_qty <> p_expected_qty then
    raise exception 'Backfill abortado: % esperava soma %, encontrou %.', p_notes, p_expected_qty, v_qty;
  end if;

  select count(*)::integer into v_linked
  from public.inventory_movements
  where event_id = p_event_id
    and movement_type = 'purchase'
    and notes = p_notes
    and receipt_id is not null;
  if v_linked <> 0 then
    raise exception 'Backfill abortado: % ja possui receipt_id.', p_notes;
  end if;

  if exists (
    select 1
    from public.inventory_movements im
    where im.event_id = p_event_id
      and im.movement_type = 'purchase'
      and im.notes = p_notes
      and not exists (
        select 1 from public.shirt_inventory si
        where si.id = im.inventory_id and si.event_id = p_event_id and si.organization_id = p_organization_id
      )
  ) then
    raise exception 'Backfill abortado: % tem inventory_id fora do evento/org.', p_notes;
  end if;

  select coalesce(jsonb_object_agg(si.shirt_type || '::' || si.shirt_size, im.quantity), '{}'::jsonb)
  into v_actual
  from public.inventory_movements im
  join public.shirt_inventory si on si.id = im.inventory_id
  where im.event_id = p_event_id
    and im.movement_type = 'purchase'
    and im.notes = p_notes;

  if v_actual is distinct from p_expected_composition then
    raise exception 'Backfill abortado: composicao de % divergente. esperado=% atual=%', p_notes, p_expected_composition, v_actual;
  end if;

  select coalesce(jsonb_object_agg(id, total_quantity), '{}'::jsonb)
  into v_snapshot
  from public.shirt_inventory
  where event_id = p_event_id;

  select id into v_existing
  from public.inventory_receipts
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    raise exception 'Backfill abortado: idempotency_key de % ja existe.', p_notes;
  end if;

  insert into public.inventory_receipts (
    organization_id, event_id, description, ordered_at, received_at, notes,
    origin, created_by, status, created_at, idempotency_key
  ) values (
    p_organization_id, p_event_id, p_description, p_ordered_at, p_received_at, p_notes,
    'historical_backfill', null, 'posted', v_created_at, p_idempotency_key
  )
  returning id into v_receipt_id;

  insert into public.inventory_receipt_items (receipt_id, organization_id, inventory_id, quantity, created_at)
  select v_receipt_id, p_organization_id, im.inventory_id, im.quantity, im.created_at
  from public.inventory_movements im
  where im.event_id = p_event_id
    and im.movement_type = 'purchase'
    and im.notes = p_notes;

  update public.inventory_movements
  set receipt_id = v_receipt_id
  where event_id = p_event_id
    and movement_type = 'purchase'
    and notes = p_notes
    and receipt_id is null;

  if exists (
    select 1
    from public.shirt_inventory si
    where si.event_id = p_event_id
      and (v_snapshot ->> si.id::text)::integer is distinct from si.total_quantity
  ) then
    raise exception 'Backfill abortado: total_quantity mudou ao vincular %.', p_notes;
  end if;

  return v_receipt_id;
end;
$$;

do $backfill$
declare
  v_event_id uuid;
  v_org_id uuid;
  v_event_count integer;
  v_existing_count integer;
  v_receipt_1 uuid;
  v_receipt_2 uuid;
  v_receipt_3 uuid;
  v_item_count integer;
  v_linked integer;
  v_linked_qty integer;
  v_adj_linked integer;
  v_receipt_qty integer;
  v_other integer;
  v_purchases_before integer;
  v_purchases_after integer;
begin
  select count(distinct event_id)::integer into v_event_count
  from public.inventory_movements
  where movement_type = 'purchase'
    and notes = 'Primeira Encomenda 11/08';

  if v_event_count = 0 then
    raise notice 'Backfill de inventory_receipts ignorado: purchases historicos nao encontrados.';
    return;
  end if;
  if v_event_count <> 1 then
    raise exception 'Backfill abortado: Primeira Encomenda 11/08 aparece em % eventos.', v_event_count;
  end if;

  select im.event_id, e.organization_id
  into v_event_id, v_org_id
  from public.inventory_movements im
  join public.events e on e.id = im.event_id
  where im.movement_type = 'purchase'
    and im.notes = 'Primeira Encomenda 11/08'
  limit 1;

  select count(*)::integer into v_existing_count
  from public.inventory_receipts
  where event_id = v_event_id
    and origin = 'historical_backfill'
    and idempotency_key in (
      '11111111-1111-4111-8111-111111111101'::uuid,
      '11111111-1111-4111-8111-111111111102'::uuid,
      '11111111-1111-4111-8111-111111111103'::uuid
    );

  if v_existing_count = 3 then
    raise notice 'Backfill de inventory_receipts ja aplicado.';
    return;
  end if;
  if v_existing_count <> 0 then
    raise exception 'Backfill abortado: estado parcial (% receipts historicos).', v_existing_count;
  end if;

  select count(*)::integer into v_purchases_before
  from public.inventory_movements
  where event_id = v_event_id and movement_type = 'purchase';

  select count(*)::integer into v_other
  from public.inventory_movements
  where event_id = v_event_id
    and movement_type = 'purchase'
    and notes not in (
      'Primeira Encomenda 11/08',
      'Segunda encomenda 22/09',
      'Segundo pedido (o que faltava) 23/09'
    );
  if v_other <> 0 then
    raise exception 'Backfill abortado: existem % purchases fora dos 3 grupos historicos.', v_other;
  end if;

  v_receipt_1 := public._backfill_historical_inventory_receipt(
    v_event_id, v_org_id,
    'Primeira Encomenda 11/08',
    'Primeira encomenda',
    date '2026-08-11',
    date '2026-08-22',
    '11111111-1111-4111-8111-111111111101'::uuid,
    16, 612,
    '{
      "Babylook::EG":3,
      "Babylook::EXG":1,
      "Babylook::EXGG":2,
      "Babylook::G":70,
      "Babylook::GG":25,
      "Babylook::M":70,
      "Babylook::P":25,
      "Babylook::PP":5,
      "Camiseta::EG":10,
      "Camiseta::EXG":4,
      "Camiseta::EXGG":3,
      "Camiseta::G":140,
      "Camiseta::GG":70,
      "Camiseta::M":140,
      "Camiseta::P":40,
      "Camiseta::PP":4
    }'::jsonb
  );

  v_receipt_2 := public._backfill_historical_inventory_receipt(
    v_event_id, v_org_id,
    'Segunda encomenda 22/09',
    'Segunda encomenda',
    date '2026-09-22',
    date '2026-09-22',
    '11111111-1111-4111-8111-111111111102'::uuid,
    11, 161,
    '{
      "Babylook::EG":2,
      "Babylook::G":8,
      "Babylook::GG":2,
      "Babylook::M":42,
      "Babylook::P":20,
      "Babylook::PP":2,
      "Camiseta::EG":14,
      "Camiseta::EXG":7,
      "Camiseta::G":24,
      "Camiseta::GG":20,
      "Camiseta::P":20
    }'::jsonb
  );

  v_receipt_3 := public._backfill_historical_inventory_receipt(
    v_event_id, v_org_id,
    'Segundo pedido (o que faltava) 23/09',
    'Segundo pedido — complemento',
    date '2026-09-23',
    date '2026-09-26',
    '11111111-1111-4111-8111-111111111103'::uuid,
    2, 104,
    '{
      "Camiseta::G":51,
      "Camiseta::M":53
    }'::jsonb
  );

  select count(*)::integer into v_item_count
  from public.inventory_receipt_items
  where receipt_id in (v_receipt_1, v_receipt_2, v_receipt_3);
  if v_item_count <> 29 then
    raise exception 'Backfill abortado: esperava 29 items, encontrou %.', v_item_count;
  end if;

  select count(*)::integer, coalesce(sum(quantity), 0)::integer
  into v_linked, v_linked_qty
  from public.inventory_movements
  where receipt_id in (v_receipt_1, v_receipt_2, v_receipt_3)
    and movement_type = 'purchase';
  if v_linked <> 29 or v_linked_qty <> 877 then
    raise exception 'Backfill abortado: purchases vinculados % / soma %.', v_linked, v_linked_qty;
  end if;

  select count(*)::integer into v_adj_linked
  from public.inventory_movements
  where receipt_id in (v_receipt_1, v_receipt_2, v_receipt_3)
    and movement_type <> 'purchase';
  if v_adj_linked <> 0 then
    raise exception 'Backfill abortado: adjustment vinculado a receipt.';
  end if;

  select coalesce(sum(i.quantity), 0)::integer into v_receipt_qty
  from public.inventory_receipt_items i
  where i.receipt_id in (v_receipt_1, v_receipt_2, v_receipt_3);
  if v_receipt_qty <> 877 then
    raise exception 'Backfill abortado: soma dos receipts %.', v_receipt_qty;
  end if;

  select count(*)::integer into v_purchases_after
  from public.inventory_movements
  where event_id = v_event_id and movement_type = 'purchase';
  if v_purchases_after is distinct from v_purchases_before then
    raise exception 'Backfill abortado: criou ou apagou purchase movements.';
  end if;
end;
$backfill$;

drop function public._backfill_historical_inventory_receipt(uuid, uuid, text, text, date, date, uuid, integer, integer, jsonb);

-- Writer legado: a aplicacao nao pode mais criar purchase sem receipt.
create or replace function public.add_inventory_quantity(p_inventory_id uuid, p_quantity integer, p_notes text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  raise exception 'Entrada fisica deve ser registrada com create_inventory_receipt.';
end;
$$;

create or replace function public.add_inventory_quantity(p_event_id uuid, p_inventory_id uuid, p_quantity integer, p_notes text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  raise exception 'Entrada fisica deve ser registrada com create_inventory_receipt.';
end;
$$;

create or replace function public.reset_event_shirt_inventory(p_event_id uuid, p_clear_history boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event public.events%rowtype;
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_before_snapshot jsonb := '[]'::jsonb;
  v_inventory_rows integer := 0;
  v_movements_before integer := 0;
  v_movements_deleted integer := 0;
  v_active_reservations integer := 0;
  v_delivered_kits integer := 0;
  v_confirmed_tickets integer := 0;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_mode text := case when coalesce(p_clear_history, false) then 'full' else 'simple' end;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  if coalesce(p_clear_history, false) then
    if not public.current_user_has_permission('inventory.clear_history') then
      raise exception 'Sem permissao para limpar historico de estoque.';
    end if;
  elsif not public.current_user_has_permission('inventory.reset') then
    raise exception 'Sem permissao para zerar estoque.';
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select lower(email) into v_actor_email from auth.users where id = v_actor;
  perform 1 from public.shirt_inventory si where si.event_id = p_event_id for update;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', si.id, 'shirt_type', si.shirt_type, 'shirt_size', si.shirt_size,
      'total_quantity', si.total_quantity, 'reserved_quantity', si.reserved_quantity,
      'delivered_quantity', si.delivered_quantity
    ) order by si.shirt_type, si.shirt_size), '[]'::jsonb),
    count(*)::integer
  into v_before_snapshot, v_inventory_rows
  from public.shirt_inventory si
  where si.event_id = p_event_id;
  select count(*)::integer into v_movements_before from public.inventory_movements where event_id = p_event_id;
  select count(*)::integer into v_active_reservations from public.order_items where event_id = p_event_id and status = 'reserved';
  select count(*)::integer into v_delivered_kits from public.participant_kit_items where event_id = p_event_id and status = 'delivered';
  select count(*)::integer into v_confirmed_tickets from public.tickets where event_id = p_event_id and status in ('active', 'used');
  if coalesce(p_clear_history, false) and (v_delivered_kits > 0 or v_confirmed_tickets > 0) then
    raise exception 'Limpeza de historico bloqueada: existem entregas reais ou tickets confirmados neste evento. Use a zeragem simples.';
  end if;
  if coalesce(p_clear_history, false) and exists (
    select 1 from public.inventory_receipts where event_id = p_event_id
  ) then
    raise exception 'Limpeza de historico bloqueada: existem entradas de estoque neste evento.';
  end if;
  update public.shirt_inventory
  set total_quantity = 0, reserved_quantity = 0, delivered_quantity = 0, updated_at = now()
  where event_id = p_event_id;
  if coalesce(p_clear_history, false) then
    delete from public.inventory_movements where event_id = p_event_id;
    get diagnostics v_movements_deleted = row_count;
  end if;
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'inventory_event_reset', 'events', p_event_id, p_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor, 'actor_email', v_actor_email, 'mode', v_mode,
      'reason', coalesce(v_reason, 'sem motivo informado'),
      'inventory_rows', v_inventory_rows, 'movements_before', v_movements_before,
      'movements_deleted', v_movements_deleted, 'active_reservations', v_active_reservations,
      'delivered_kits', v_delivered_kits, 'confirmed_tickets', v_confirmed_tickets,
      'before_snapshot', v_before_snapshot, 'cleared_history', coalesce(p_clear_history, false)
    )
  );
  return jsonb_build_object(
    'event_id', p_event_id, 'mode', v_mode, 'inventory_rows', v_inventory_rows,
    'movements_before', v_movements_before, 'movements_deleted', v_movements_deleted,
    'active_reservations', v_active_reservations, 'delivered_kits', v_delivered_kits,
    'confirmed_tickets', v_confirmed_tickets
  );
end;
$$;

commit;
