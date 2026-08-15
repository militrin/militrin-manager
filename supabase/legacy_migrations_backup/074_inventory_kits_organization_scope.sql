-- 074_inventory_kits_organization_scope.sql
-- Adiciona organization_id às tabelas de estoque e kits.
-- Corrige constraint de movement_type que bloqueava 'kit_delivery_undo'.
-- Atualiza RPCs de entrega/desfazer/troca com org access + audit sem actor.

begin;

-- ============================================================
-- CORREÇÃO PRÉVIA: movement_type CHECK constraint
-- A constraint original só permite ('purchase','adjustment','return','loss'),
-- mas migration 063 insere 'kit_delivery_undo'. Removemos e expandimos.
-- ============================================================

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'inventory_movements_movement_type_check'
      and conrelid = 'public.inventory_movements'::regclass
  ) then
    alter table public.inventory_movements
      drop constraint inventory_movements_movement_type_check;
  end if;
end $$;

alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in (
    'purchase', 'adjustment', 'return', 'loss',
    'kit_delivery_undo', 'reservation', 'release', 'cancel'
  ));

-- ============================================================
-- 1. shirt_inventory
-- ============================================================

alter table public.shirt_inventory
  add column if not exists organization_id uuid
    references public.organizations(id);

do $$
declare
  v_orphan_event  integer;
  v_event_no_org  integer;
begin
  select count(*) into v_orphan_event
  from public.shirt_inventory si
  where not exists (select 1 from public.events e where e.id = si.event_id);

  select count(*) into v_event_no_org
  from public.shirt_inventory si
  join public.events e on e.id = si.event_id
  where e.organization_id is null;

  if v_orphan_event > 0 or v_event_no_org > 0 then
    raise exception
      'shirt_inventory: % event_id inexistente, % evento sem org. Corrija antes de reaplicar.',
      v_orphan_event, v_event_no_org;
  end if;
end $$;

update public.shirt_inventory si
set organization_id = e.organization_id
from public.events e
where e.id = si.event_id
  and si.organization_id is null;

alter table public.shirt_inventory
  alter column organization_id set not null;

create index if not exists idx_shirt_inventory_org
  on public.shirt_inventory(organization_id);
create index if not exists idx_shirt_inventory_org_event
  on public.shirt_inventory(organization_id, event_id);
create index if not exists idx_shirt_inventory_org_event_type_size
  on public.shirt_inventory(organization_id, event_id, shirt_type, shirt_size);

create or replace function public.trg_shirt_inventory_set_org()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_org is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then
    raise exception 'organization_id divergente no shirt_inventory (esperado %).',  v_org;
  end if;
  NEW.organization_id := v_org;
  return NEW;
end;
$$;

drop trigger if exists trg_shirt_inventory_org on public.shirt_inventory;
create trigger trg_shirt_inventory_org
  before insert or update on public.shirt_inventory
  for each row execute function public.trg_shirt_inventory_set_org();

-- ============================================================
-- 2. event_kit_items
-- ============================================================

alter table public.event_kit_items
  add column if not exists organization_id uuid
    references public.organizations(id);

do $$
declare
  v_orphan_event integer;
  v_event_no_org integer;
begin
  select count(*) into v_orphan_event
  from public.event_kit_items eki
  where not exists (select 1 from public.events e where e.id = eki.event_id);

  select count(*) into v_event_no_org
  from public.event_kit_items eki
  join public.events e on e.id = eki.event_id
  where e.organization_id is null;

  if v_orphan_event > 0 or v_event_no_org > 0 then
    raise exception
      'event_kit_items: % event_id inexistente, % evento sem org.',
      v_orphan_event, v_event_no_org;
  end if;
end $$;

update public.event_kit_items eki
set organization_id = e.organization_id
from public.events e
where e.id = eki.event_id
  and eki.organization_id is null;

alter table public.event_kit_items
  alter column organization_id set not null;

create index if not exists idx_event_kit_items_org
  on public.event_kit_items(organization_id);
create index if not exists idx_event_kit_items_org_event
  on public.event_kit_items(organization_id, event_id);

create or replace function public.trg_event_kit_items_set_org()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_org is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then
    raise exception 'organization_id divergente em event_kit_items (esperado %).', v_org;
  end if;
  NEW.organization_id := v_org;
  return NEW;
end;
$$;

drop trigger if exists trg_event_kit_items_org on public.event_kit_items;
create trigger trg_event_kit_items_org
  before insert or update on public.event_kit_items
  for each row execute function public.trg_event_kit_items_set_org();

-- ============================================================
-- 3. participant_kit_items
-- ============================================================

alter table public.participant_kit_items
  add column if not exists organization_id uuid
    references public.organizations(id);

do $$
declare
  v_orphan_event     integer;
  v_orphan_part      integer;
  v_orphan_kit_item  integer;
  v_divergence       integer;
begin
  select count(*) into v_orphan_event
  from public.participant_kit_items pki
  where not exists (select 1 from public.events e where e.id = pki.event_id);

  select count(*) into v_orphan_part
  from public.participant_kit_items pki
  where not exists (select 1 from public.participants p where p.id = pki.participant_id);

  select count(*) into v_orphan_kit_item
  from public.participant_kit_items pki
  where not exists (select 1 from public.event_kit_items eki where eki.id = pki.kit_item_id);

  select count(*) into v_divergence
  from public.participant_kit_items pki
  join public.events e       on e.id   = pki.event_id
  join public.participants p on p.id   = pki.participant_id
  where e.organization_id is not null
    and p.organization_id is not null
    and e.organization_id <> p.organization_id;

  if v_orphan_event > 0 or v_orphan_part > 0 or v_orphan_kit_item > 0 or v_divergence > 0 then
    raise exception
      'participant_kit_items: % event inexistente, % participant inexistente, % kit_item inexistente, % divergência event/participant.',
      v_orphan_event, v_orphan_part, v_orphan_kit_item, v_divergence;
  end if;
end $$;

update public.participant_kit_items pki
set organization_id = e.organization_id
from public.events e
where e.id = pki.event_id
  and pki.organization_id is null;

alter table public.participant_kit_items
  alter column organization_id set not null;

create index if not exists idx_participant_kit_items_org
  on public.participant_kit_items(organization_id);
create index if not exists idx_participant_kit_items_org_event
  on public.participant_kit_items(organization_id, event_id);

create or replace function public.trg_participant_kit_items_set_org()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event_org uuid;
  v_part_org  uuid;
  v_kit_org   uuid;
begin
  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_event_org is null then
    raise exception 'Evento % sem organization_id.', NEW.event_id;
  end if;

  select organization_id into v_part_org
  from public.participants where id = NEW.participant_id;
  if found and v_part_org is not null and v_part_org <> v_event_org then
    raise exception
      'Divergência: participante (org %) e evento (org %) em participant_kit_items.',
      v_part_org, v_event_org;
  end if;

  select organization_id into v_kit_org
  from public.event_kit_items where id = NEW.kit_item_id;
  if found and v_kit_org is not null and v_kit_org <> v_event_org then
    raise exception
      'Divergência: kit_item (org %) e evento (org %) em participant_kit_items.',
      v_kit_org, v_event_org;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org then
    raise exception 'organization_id divergente em participant_kit_items (esperado %).', v_event_org;
  end if;

  NEW.organization_id := v_event_org;
  return NEW;
end;
$$;

drop trigger if exists trg_participant_kit_items_org on public.participant_kit_items;
create trigger trg_participant_kit_items_org
  before insert or update on public.participant_kit_items
  for each row execute function public.trg_participant_kit_items_set_org();

-- ============================================================
-- 4. inventory_movements
-- ============================================================

alter table public.inventory_movements
  add column if not exists organization_id uuid
    references public.organizations(id);

do $$
declare
  v_orphan_event     integer;
  v_orphan_inventory integer;
  v_divergence       integer;
begin
  select count(*) into v_orphan_event
  from public.inventory_movements im
  where not exists (select 1 from public.events e where e.id = im.event_id);

  select count(*) into v_orphan_inventory
  from public.inventory_movements im
  where not exists (select 1 from public.shirt_inventory si where si.id = im.inventory_id);

  select count(*) into v_divergence
  from public.inventory_movements im
  join public.events e        on e.id  = im.event_id
  join public.shirt_inventory si on si.id = im.inventory_id
  where e.organization_id  is not null
    and si.organization_id is not null
    and e.organization_id <> si.organization_id;

  if v_orphan_event > 0 or v_orphan_inventory > 0 or v_divergence > 0 then
    raise exception
      'inventory_movements: % event inexistente, % inventory inexistente, % divergência event/inventory.',
      v_orphan_event, v_orphan_inventory, v_divergence;
  end if;
end $$;

update public.inventory_movements im
set organization_id = e.organization_id
from public.events e
where e.id = im.event_id
  and im.organization_id is null;

alter table public.inventory_movements
  alter column organization_id set not null;

create index if not exists idx_inventory_movements_org
  on public.inventory_movements(organization_id);
create index if not exists idx_inventory_movements_org_event
  on public.inventory_movements(organization_id, event_id);

create or replace function public.trg_inventory_movements_set_org()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event_org     uuid;
  v_inventory_org uuid;
begin
  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;
  if v_event_org is null then
    raise exception 'Evento % sem organization_id.', NEW.event_id;
  end if;

  select organization_id into v_inventory_org
  from public.shirt_inventory where id = NEW.inventory_id;
  if found and v_inventory_org is not null and v_inventory_org <> v_event_org then
    raise exception
      'Divergência: inventory (org %) e evento (org %) em inventory_movements.',
      v_inventory_org, v_event_org;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org then
    raise exception 'organization_id divergente em inventory_movements (esperado %).', v_event_org;
  end if;

  NEW.organization_id := v_event_org;
  return NEW;
end;
$$;

drop trigger if exists trg_inventory_movements_org on public.inventory_movements;
create trigger trg_inventory_movements_org
  before insert or update on public.inventory_movements
  for each row execute function public.trg_inventory_movements_set_org();

-- ============================================================
-- 5. RLS
-- shirt_inventory e event_kit_items: mantêm leitura pública (checkout e portal
-- precisam de contagens de estoque e itens do kit sem autenticação).
-- participant_kit_items: reconstrução com org-scoping (dados vinculados a participantes).
-- inventory_movements: mudança para acesso admin-only com org-scoping.
-- ============================================================

-- --- shirt_inventory ---
-- Mantém SELECT aberto para anon e authenticated (checkout público precisa disso).
drop policy if exists "shirt_inventory_read_only" on public.shirt_inventory;
create policy "shirt_inventory_read_only"
  on public.shirt_inventory for select
  to anon, authenticated
  using (true);

-- --- event_kit_items ---
drop policy if exists "event_kit_items_read_only" on public.event_kit_items;
create policy "event_kit_items_read_only"
  on public.event_kit_items for select
  to anon, authenticated
  using (true);

-- --- inventory_movements: admin-only com org-scoping ---
drop policy if exists "inventory_movements_read_only" on public.inventory_movements;
drop policy if exists "inventory_movements_rbac_select" on public.inventory_movements;
create policy "inventory_movements_rbac_select"
  on public.inventory_movements for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'inventory.view')
        or public.resolve_user_permission(auth.uid(), 'inventory.view_history')
        or public.resolve_user_permission(auth.uid(), 'inventory.adjust')
        or public.resolve_user_permission(auth.uid(), 'inventory.clear_history')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- --- participant_kit_items: reconstrução de 059 com org-scoping ---
-- Participante vê os próprios itens de kit (sem org-scoping necessário)
drop policy if exists participant_kit_items_owner_select on public.participant_kit_items;
create policy participant_kit_items_owner_select
  on public.participant_kit_items for select
  to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = participant_kit_items.participant_id
        and p.user_id = auth.uid()
    )
  );

-- SELECT administrativo com org-scoping
drop policy if exists participant_kit_items_rbac_select on public.participant_kit_items;
create policy participant_kit_items_rbac_select
  on public.participant_kit_items for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'kits.view')
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
        or public.resolve_user_permission(auth.uid(), 'kits.replace_item')
        or public.resolve_user_permission(auth.uid(), 'kits.undo_delivery')
        or public.resolve_user_permission(auth.uid(), 'kits.view_history')
        or public.resolve_user_permission(auth.uid(), 'participants.view')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- INSERT com org-scoping via event_id (organization_id ainda não está definido quando RLS avalia)
drop policy if exists participant_kit_items_rbac_insert on public.participant_kit_items;
create policy participant_kit_items_rbac_insert
  on public.participant_kit_items for insert
  to authenticated
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'participants.create')
        or public.resolve_user_permission(auth.uid(), 'imports.create')
        or public.resolve_user_permission(auth.uid(), 'kits.replace_item')
      )
      and (
        event_id is null
        or public.user_can_access_organization(
          auth.uid(),
          (select e.organization_id from public.events e where e.id = event_id)
        )
      )
    )
  );

-- UPDATE com org-scoping
drop policy if exists participant_kit_items_rbac_update on public.participant_kit_items;
create policy participant_kit_items_rbac_update
  on public.participant_kit_items for update
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
        or public.resolve_user_permission(auth.uid(), 'kits.replace_item')
        or public.resolve_user_permission(auth.uid(), 'kits.undo_delivery')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  )
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
        or public.resolve_user_permission(auth.uid(), 'kits.replace_item')
        or public.resolve_user_permission(auth.uid(), 'kits.undo_delivery')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- DELETE restrito ao Owner (inalterado)
drop policy if exists participant_kit_items_owner_delete on public.participant_kit_items;
create policy participant_kit_items_owner_delete
  on public.participant_kit_items for delete
  to authenticated
  using (public.is_active_owner(auth.uid()));

-- ============================================================
-- 6. RPCs ATUALIZADAS
-- Adiciona org access check após localizar o registro principal.
-- Corrige audit_logs: remove coluna actor onde ainda usada.
-- ============================================================

-- deliver_participant_kit_item: org check + fix actor column no audit_logs
create or replace function public.deliver_participant_kit_item(
  p_participant_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item        public.participant_kit_items%rowtype;
  v_participant public.participants%rowtype;
  v_kit_item    public.event_kit_items%rowtype;
  v_inventory   public.shirt_inventory%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('kits.deliver') then
    raise exception 'Sem permissao para entregar kit.';
  end if;

  if p_participant_id is null or p_kit_item_id is null then
    raise exception 'Participante e item sao obrigatorios.';
  end if;

  select * into v_item
  from public.participant_kit_items
  where participant_id = p_participant_id
    and kit_item_id = p_kit_item_id
  for update;

  if not found then
    raise exception 'Item do participante nao encontrado.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_item.organization_id) then
    raise exception 'Sem permissao para entregar kit nesta organização.';
  end if;

  if v_item.status = 'delivered' then
    raise exception 'Item ja foi entregue anteriormente.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Entrega bloqueada.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Entrega bloqueada.';
  end if;

  select * into v_kit_item
  from public.event_kit_items
  where id = p_kit_item_id;

  if not found then
    raise exception 'Configuracao de item nao encontrada.';
  end if;

  if v_kit_item.item_type = 'shirt' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id  = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para a camiseta do participante.';
    end if;

    if v_inventory.reserved_quantity < v_item.quantity then
      raise exception 'Reserva de camiseta insuficiente para entrega.';
    end if;

    update public.shirt_inventory
    set reserved_quantity  = reserved_quantity  - v_item.quantity,
        delivered_quantity = delivered_quantity + v_item.quantity,
        updated_at         = now()
    where id = v_inventory.id;
  end if;

  update public.participant_kit_items
  set status       = 'delivered',
      delivered_at = now()
  where id = v_item.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'participant_kit_item_delivered',
    'participant_kit_items',
    v_item.id,
    v_item.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_item.organization_id,
      'participant_id', p_participant_id,
      'kit_item_id', p_kit_item_id,
      'item_type', v_kit_item.item_type,
      'quantity', v_item.quantity
    )
  );

  return true;
end;
$$;

-- undo_participant_kit_item: org check (audit_logs já estava correto em 063)
create or replace function public.undo_participant_kit_item(
  p_participant_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item        public.participant_kit_items%rowtype;
  v_participant public.participants%rowtype;
  v_kit_item    public.event_kit_items%rowtype;
  v_inventory   public.shirt_inventory%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('kits.undo_delivery') then
    raise exception 'Sem permissao para desfazer entrega de kit.';
  end if;

  select pki.* into v_item
  from public.participant_kit_items pki
  where pki.participant_id = p_participant_id
    and pki.kit_item_id    = p_kit_item_id
  for update;

  if not found then
    raise exception 'Item do participante nao encontrado.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_item.organization_id) then
    raise exception 'Sem permissao para desfazer entrega nesta organização.';
  end if;

  if v_item.status <> 'delivered' then
    raise exception 'Este item ainda nao foi entregue.';
  end if;

  select p.* into v_participant
  from public.participants p
  where p.id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select eki.* into v_kit_item
  from public.event_kit_items eki
  where eki.id = p_kit_item_id;

  if not found then
    raise exception 'Configuracao de item nao encontrada.';
  end if;

  if v_kit_item.item_type = 'shirt' then
    select si.* into v_inventory
    from public.shirt_inventory si
    where si.event_id   = v_participant.event_id
      and si.shirt_type = v_participant.shirt_type
      and si.shirt_size = v_participant.shirt_size
    for update;

    if found then
      if coalesce(v_inventory.delivered_quantity, 0) < v_item.quantity then
        raise exception 'Quantidade entregue inconsistente no estoque.';
      end if;

      update public.shirt_inventory si
      set delivered_quantity = coalesce(si.delivered_quantity, 0) - v_item.quantity,
          reserved_quantity  = coalesce(si.reserved_quantity,  0) + v_item.quantity,
          updated_at         = now()
      where si.id = v_inventory.id;

      insert into public.inventory_movements (event_id, inventory_id, movement_type, quantity, notes)
      values (
        v_participant.event_id,
        v_inventory.id,
        'kit_delivery_undo',
        v_item.quantity,
        format('Entrega desfeita para %s. Operador: %s.',
          coalesce(v_participant.full_name, p_participant_id::text),
          v_actor_email
        )
      );
    end if;
  end if;

  update public.participant_kit_items pki
  set status       = 'confirmed',
      delivered_at = null
  where pki.id = v_item.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'participant_kit_item_delivery_undone',
    'participant_kit_items',
    v_item.id,
    v_item.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_item.organization_id,
      'participant_id', p_participant_id,
      'kit_item_id', p_kit_item_id,
      'item_type', v_kit_item.item_type,
      'quantity', v_item.quantity
    )
  );

  return true;
end;
$function$;

-- change_participant_shirt: org check (audit_logs já estava correto em 063)
create or replace function public.change_participant_shirt(
  p_participant_id uuid,
  p_new_shirt_type text,
  p_new_shirt_size text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_participant  public.participants%rowtype;
  v_event        public.events%rowtype;
  v_shirt_item   public.participant_kit_items%rowtype;
  v_old_inventory public.shirt_inventory%rowtype;
  v_new_inventory public.shirt_inventory%rowtype;
  v_quantity     integer := 1;
  v_is_delivered boolean := false;
  v_enforce_stock boolean := false;
  v_available    integer;
  v_new_type     text := nullif(trim(p_new_shirt_type), '');
  v_new_size     text := nullif(trim(p_new_shirt_size), '');
  v_actor_email  text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('inventory.change_participant_shirt') then
    raise exception 'Sem permissao para trocar camiseta do participante.';
  end if;

  if v_new_type is null or v_new_size is null then
    raise exception 'Tipo e tamanho da nova camiseta sao obrigatorios.';
  end if;

  select p.* into v_participant
  from public.participants p
  where p.id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_participant.organization_id) then
    raise exception 'Sem permissao para trocar camiseta nesta organização.';
  end if;

  if v_participant.shirt_type = v_new_type and v_participant.shirt_size = v_new_size then
    raise exception 'A nova camiseta e igual a atual.';
  end if;

  select e.* into v_event
  from public.events e
  where e.id = v_participant.event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  v_enforce_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select pki.* into v_shirt_item
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id = pki.kit_item_id
  where pki.participant_id = p_participant_id
    and eki.item_type = 'shirt'
  order by pki.created_at asc
  limit 1
  for update;

  if found then
    v_quantity     := greatest(coalesce(v_shirt_item.quantity, 1), 1);
    v_is_delivered := v_shirt_item.status = 'delivered';
  end if;

  select si.* into v_old_inventory
  from public.shirt_inventory si
  where si.event_id   = v_participant.event_id
    and si.shirt_type = v_participant.shirt_type
    and si.shirt_size = v_participant.shirt_size
  for update;

  select si.* into v_new_inventory
  from public.shirt_inventory si
  where si.event_id   = v_participant.event_id
    and si.shirt_type = v_new_type
    and si.shirt_size = v_new_size
  for update;

  if v_enforce_stock and not found then
    raise exception 'Novo tamanho nao possui estoque cadastrado.';
  end if;

  if v_new_inventory.id is not null then
    v_available :=
      coalesce(v_new_inventory.total_quantity, 0)
      - coalesce(v_new_inventory.reserved_quantity, 0)
      - coalesce(v_new_inventory.delivered_quantity, 0);
    if v_available < v_quantity then
      raise exception 'Novo tamanho esgotado ou com saldo insuficiente.';
    end if;
  end if;

  if v_old_inventory.id is not null then
    if v_is_delivered then
      update public.shirt_inventory si
      set delivered_quantity = greatest(coalesce(si.delivered_quantity, 0) - v_quantity, 0),
          updated_at = now()
      where si.id = v_old_inventory.id;
    else
      update public.shirt_inventory si
      set reserved_quantity = greatest(coalesce(si.reserved_quantity, 0) - v_quantity, 0),
          updated_at = now()
      where si.id = v_old_inventory.id;
    end if;
  end if;

  if v_new_inventory.id is not null then
    if v_is_delivered then
      update public.shirt_inventory si
      set delivered_quantity = coalesce(si.delivered_quantity, 0) + v_quantity,
          updated_at = now()
      where si.id = v_new_inventory.id;
    else
      update public.shirt_inventory si
      set reserved_quantity = coalesce(si.reserved_quantity, 0) + v_quantity,
          updated_at = now()
      where si.id = v_new_inventory.id;
    end if;
  end if;

  update public.participants p
  set shirt_type = v_new_type,
      shirt_size = v_new_size,
      updated_at = now()
  where p.id = p_participant_id;

  if v_shirt_item.id is not null then
    update public.participant_kit_items pki
    set variant_data = jsonb_build_object('shirt_type', v_new_type, 'shirt_size', v_new_size)
    where pki.id = v_shirt_item.id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'participant_shirt_changed',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_participant.organization_id,
      'previous_type', v_participant.shirt_type,
      'previous_size', v_participant.shirt_size,
      'next_type', v_new_type,
      'next_size', v_new_size,
      'kit_item_delivered', v_is_delivered,
      'quantity', v_quantity
    )
  );

  return true;
end;
$function$;

grant execute on function public.deliver_participant_kit_item(uuid, uuid) to authenticated;
grant execute on function public.undo_participant_kit_item(uuid, uuid) to authenticated;
grant execute on function public.change_participant_shirt(uuid, text, text) to authenticated;

-- ============================================================
-- 7. AUDITORIA DA MIGRATION
-- ============================================================

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
values (
  'inventory_kits_org_backfill',
  'organizations',
  (select id from public.organizations where slug = 'militrin' limit 1),
  null,
  jsonb_build_object(
    'actor', 'system',
    'migration', '074_inventory_kits_organization_scope',
    'tables', jsonb_build_array(
      'shirt_inventory', 'event_kit_items',
      'participant_kit_items', 'inventory_movements'
    )
  )
);

commit;
