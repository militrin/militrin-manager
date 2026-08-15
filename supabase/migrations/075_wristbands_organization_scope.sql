-- 075_wristbands_organization_scope.sql
-- Adiciona organization_id a participant_wristbands, derivado do ticket.
-- Atualiza RPCs com org access check e organization_id em audit details.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable para backfill)
-- ============================================================

alter table public.participant_wristbands
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. DIAGNÓSTICO
-- Fonte primária: ticket_id → tickets.organization_id.
-- Valida convergência com event_id e participant_id.
-- ============================================================

do $$
declare
  v_orphan_ticket    integer;
  v_ticket_no_org    integer;
  v_orphan_event     integer;
  v_orphan_part      integer;
  v_div_ticket_event integer;
  v_div_ticket_part  integer;
begin
  select count(*) into v_orphan_ticket
  from public.participant_wristbands pw
  where not exists (select 1 from public.tickets t where t.id = pw.ticket_id);

  select count(*) into v_ticket_no_org
  from public.participant_wristbands pw
  join public.tickets t on t.id = pw.ticket_id
  where t.organization_id is null;

  select count(*) into v_orphan_event
  from public.participant_wristbands pw
  where not exists (select 1 from public.events e where e.id = pw.event_id);

  select count(*) into v_orphan_part
  from public.participant_wristbands pw
  where pw.participant_id is not null
    and not exists (select 1 from public.participants p where p.id = pw.participant_id);

  -- Divergência ticket ↔ event
  select count(*) into v_div_ticket_event
  from public.participant_wristbands pw
  join public.tickets t on t.id  = pw.ticket_id
  join public.events  e on e.id  = pw.event_id
  where t.organization_id is not null
    and e.organization_id is not null
    and t.organization_id <> e.organization_id;

  -- Divergência ticket ↔ participant
  select count(*) into v_div_ticket_part
  from public.participant_wristbands pw
  join public.tickets      t on t.id = pw.ticket_id
  join public.participants p on p.id = pw.participant_id
  where pw.participant_id is not null
    and t.organization_id is not null
    and p.organization_id is not null
    and t.organization_id <> p.organization_id;

  if v_orphan_ticket > 0 or v_ticket_no_org > 0 or v_orphan_event > 0
     or v_orphan_part > 0 or v_div_ticket_event > 0 or v_div_ticket_part > 0 then
    raise exception
      'participant_wristbands: % ticket inexistente, % ticket sem org, % event inexistente, % participant inexistente, % div ticket/event, % div ticket/participant. Corrija antes de reaplicar.',
      v_orphan_ticket, v_ticket_no_org, v_orphan_event,
      v_orphan_part, v_div_ticket_event, v_div_ticket_part;
  end if;
end $$;

-- ============================================================
-- 3. BACKFILL via tickets (fonte primária)
-- ============================================================

update public.participant_wristbands pw
set organization_id = t.organization_id
from public.tickets t
where t.id = pw.ticket_id
  and pw.organization_id is null;

-- ============================================================
-- 4. NOT NULL + ÍNDICES
-- ============================================================

alter table public.participant_wristbands
  alter column organization_id set not null;

create index if not exists idx_wristbands_organization_id
  on public.participant_wristbands(organization_id);

create index if not exists idx_wristbands_org_event
  on public.participant_wristbands(organization_id, event_id);

create index if not exists idx_wristbands_org_ticket
  on public.participant_wristbands(organization_id, ticket_id);

-- Índice parcial para busca rápida de pulseira ativa por organização/evento/código
create index if not exists idx_wristbands_org_code_active
  on public.participant_wristbands(organization_id, event_id, lower(code))
  where status = 'active';

-- ============================================================
-- 5. TRIGGER DE CONSISTÊNCIA
-- Fonte primária: ticket_id → tickets.organization_id.
-- Valida convergência com event_id e participant_id quando presentes.
-- ============================================================

create or replace function public.trg_wristbands_set_organization_id()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ticket_org uuid;
  v_event_org  uuid;
  v_part_org   uuid;
begin
  select organization_id into v_ticket_org
  from public.tickets where id = NEW.ticket_id;
  if not found then
    raise exception 'Ingresso % não encontrado em tickets.', NEW.ticket_id;
  end if;
  if v_ticket_org is null then
    raise exception 'Ingresso % não possui organization_id.', NEW.ticket_id;
  end if;

  select organization_id into v_event_org
  from public.events where id = NEW.event_id;
  if found and v_event_org is not null and v_event_org <> v_ticket_org then
    raise exception
      'Divergência: ingresso (org %) e evento (org %) em participant_wristbands.',
      v_ticket_org, v_event_org;
  end if;

  if NEW.participant_id is not null then
    select organization_id into v_part_org
    from public.participants where id = NEW.participant_id;
    if found and v_part_org is not null and v_part_org <> v_ticket_org then
      raise exception
        'Divergência: ingresso (org %) e participante (org %) em participant_wristbands.',
        v_ticket_org, v_part_org;
    end if;
  end if;

  if NEW.organization_id is not null and NEW.organization_id <> v_ticket_org then
    raise exception
      'organization_id % diverge da organização do ingresso % (esperado: %).',
      NEW.organization_id, NEW.ticket_id, v_ticket_org;
  end if;

  NEW.organization_id := v_ticket_org;
  return NEW;
end;
$$;

drop trigger if exists trg_wristbands_org_consistency on public.participant_wristbands;
create trigger trg_wristbands_org_consistency
  before insert or update on public.participant_wristbands
  for each row execute function public.trg_wristbands_set_organization_id();

-- ============================================================
-- 6. RLS RECONSTRUÍDA com org-scoping
-- Políticas anteriores de 064 não tinham org check.
-- Platform owner acessa tudo; demais exigem org access + permissão.
-- ============================================================

drop policy if exists participant_wristbands_rbac_select on public.participant_wristbands;
create policy participant_wristbands_rbac_select
  on public.participant_wristbands for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'wristbands.view')
        or public.resolve_user_permission(auth.uid(), 'wristbands.link')
        or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
        or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
        or public.resolve_user_permission(auth.uid(), 'wristbands.block')
        or public.resolve_user_permission(auth.uid(), 'kits.view')
        or public.resolve_user_permission(auth.uid(), 'checkin.view')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- INSERT: org verificada via ticket_id (organization_id ainda não existe quando RLS avalia)
drop policy if exists participant_wristbands_rbac_insert on public.participant_wristbands;
create policy participant_wristbands_rbac_insert
  on public.participant_wristbands for insert
  to authenticated
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'wristbands.link')
        or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
      )
      and public.user_can_access_organization(
        auth.uid(),
        (select t.organization_id from public.tickets t where t.id = ticket_id)
      )
    )
  );

drop policy if exists participant_wristbands_rbac_update on public.participant_wristbands;
create policy participant_wristbands_rbac_update
  on public.participant_wristbands for update
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
        or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
        or public.resolve_user_permission(auth.uid(), 'wristbands.block')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  )
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
        or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
        or public.resolve_user_permission(auth.uid(), 'wristbands.block')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- ============================================================
-- 7. RPCs ATUALIZADAS
-- Adiciona org access check após localizar o registro principal.
-- Adiciona organization_id em audit details.
-- Os RPCs de 064 já usavam actor_user_id/actor_email em details (correto).
-- ============================================================

create or replace function public.link_wristband_to_ticket(
  p_ticket_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ticket    public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event     public.events%rowtype;
  v_existing  public.participant_wristbands%rowtype;
  v_wristband public.participant_wristbands%rowtype;
  v_code      text := nullif(trim(p_code), '');
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.link')
  ) then
    raise exception 'Sem permissao para vincular pulseira.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;
  if v_code is null then
    raise exception 'Codigo da pulseira obrigatorio.';
  end if;

  select t.* into v_ticket from public.tickets t
  where t.id = p_ticket_id for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  -- Verifica org access via ticket
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para vincular pulseira nesta organização.';
  end if;

  if v_ticket.participant_id is null then
    raise exception 'Ingresso ainda nao possui participante vinculado.';
  end if;

  select p.* into v_participant from public.participants p
  where p.id = v_ticket.participant_id;
  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select e.* into v_event from public.events e
  where e.id = v_participant.event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;
  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  select pw.* into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_participant.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1 for update;

  if found then
    if v_existing.ticket_id = p_ticket_id then
      return jsonb_build_object(
        'success', true, 'already_linked', true,
        'wristband_id', v_existing.id, 'code', v_existing.code
      );
    end if;
    raise exception 'Pulseira ja vinculada a outro ingresso.';
  end if;

  if exists (
    select 1 from public.participant_wristbands pw
    where pw.ticket_id = p_ticket_id and pw.status = 'active'
  ) then
    raise exception 'Este ingresso ja possui uma pulseira ativa.';
  end if;

  insert into public.participant_wristbands (
    event_id, ticket_id, participant_id, code, status, linked_at, linked_by
  ) values (
    v_participant.event_id, p_ticket_id, v_participant.id,
    v_code, 'active', now(), auth.uid()
  )
  returning * into v_wristband;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_linked', 'participant_wristbands', v_wristband.id, v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id,
      'participant_id', v_participant.id,
      'code', v_code
    )
  );

  return jsonb_build_object(
    'success', true, 'already_linked', false,
    'wristband_id', v_wristband.id, 'code', v_wristband.code
  );
end;
$function$;

create or replace function public.unlink_wristband_from_ticket(
  p_ticket_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_wristband   public.participant_wristbands%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.unlink')
  ) then
    raise exception 'Sem permissao para desvincular pulseira.';
  end if;

  select pw.* into v_wristband
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id and pw.status = 'active'
  limit 1 for update;

  if not found then
    raise exception 'Nenhuma pulseira ativa encontrada para este ingresso.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_wristband.organization_id) then
    raise exception 'Sem permissao para desvincular pulseira nesta organização.';
  end if;

  update public.participant_wristbands pw
  set status      = 'unlinked',
      unlinked_at = now(),
      unlinked_by = auth.uid(),
      notes       = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at  = now()
  where pw.id = v_wristband.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_unlinked', 'participant_wristbands', v_wristband.id, v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', p_ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$function$;

create or replace function public.replace_wristband_for_ticket(
  p_ticket_id uuid,
  p_new_code text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old        public.participant_wristbands%rowtype;
  v_new_result jsonb;
  v_new_id     uuid;
  v_ticket_org uuid;
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.replace')
  ) then
    raise exception 'Sem permissao para substituir pulseira.';
  end if;

  -- Verifica org access via ticket antes de qualquer operação
  select t.organization_id into v_ticket_org
  from public.tickets t where t.id = p_ticket_id;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;
  if not public.user_can_access_organization(auth.uid(), v_ticket_org) then
    raise exception 'Sem permissao para substituir pulseira nesta organização.';
  end if;

  select pw.* into v_old
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id and pw.status = 'active'
  limit 1 for update;

  if found then
    update public.participant_wristbands pw
    set status      = 'replaced',
        unlinked_at = now(),
        unlinked_by = auth.uid(),
        notes       = nullif(trim(coalesce(p_reason, '')), ''),
        updated_at  = now()
    where pw.id = v_old.id;
  end if;

  v_new_result := public.link_wristband_to_ticket(p_ticket_id, p_new_code);
  v_new_id := nullif(v_new_result ->> 'wristband_id', '')::uuid;

  if v_old.id is not null and v_new_id is not null then
    update public.participant_wristbands
    set replaced_by_wristband_id = v_new_id, updated_at = now()
    where id = v_old.id;
  end if;

  return v_new_result || jsonb_build_object('replaced_wristband_id', v_old.id);
end;
$function$;

create or replace function public.block_wristband(
  p_wristband_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_wristband   public.participant_wristbands%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.block')
  ) then
    raise exception 'Sem permissao para bloquear pulseira.';
  end if;

  select pw.* into v_wristband
  from public.participant_wristbands pw
  where pw.id = p_wristband_id for update;

  if not found then
    raise exception 'Pulseira nao encontrada.';
  end if;

  -- Verifica org access
  if not public.user_can_access_organization(auth.uid(), v_wristband.organization_id) then
    raise exception 'Sem permissao para bloquear pulseira nesta organização.';
  end if;

  if v_wristband.status <> 'active' then
    raise exception 'Somente pulseira ativa pode ser bloqueada.';
  end if;

  update public.participant_wristbands pw
  set status     = 'blocked',
      notes      = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at = now()
  where pw.id = p_wristband_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'wristband_blocked', 'participant_wristbands', p_wristband_id, v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'organization_id', v_wristband.organization_id,
      'ticket_id', v_wristband.ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$function$;

grant execute on function public.link_wristband_to_ticket(uuid, text)    to authenticated;
grant execute on function public.unlink_wristband_from_ticket(uuid, text) to authenticated;
grant execute on function public.replace_wristband_for_ticket(uuid, text, text) to authenticated;
grant execute on function public.block_wristband(uuid, text)             to authenticated;

-- ============================================================
-- 8. AUDITORIA DA MIGRATION
-- ============================================================

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
values (
  'wristbands_org_backfill',
  'organizations',
  (select id from public.organizations where slug = 'militrin' limit 1),
  null,
  jsonb_build_object(
    'actor', 'system',
    'migration', '075_wristbands_organization_scope'
  )
);

commit;
