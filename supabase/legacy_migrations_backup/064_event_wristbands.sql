-- 064_event_wristbands_corrected.sql
-- Pulseiras vinculadas por ingresso, com configuração por evento e RPCs operacionais.

begin;

-- =========================================================
-- CONFIGURAÇÃO DO EVENTO
-- =========================================================

alter table public.events
  add column if not exists wristband_enabled boolean not null default false,
  add column if not exists wristband_required_for_kit boolean not null default false,
  add column if not exists wristband_required_for_checkin boolean not null default false;

-- Mantém as opções coerentes.
alter table public.events
  drop constraint if exists events_wristband_requirements_check;

alter table public.events
  add constraint events_wristband_requirements_check
  check (
    wristband_enabled
    or (
      wristband_required_for_kit = false
      and wristband_required_for_checkin = false
    )
  );

-- =========================================================
-- PERMISSÕES
-- =========================================================

insert into public.admin_permissions (
  code,
  name,
  description,
  module,
  sort_order,
  is_active
)
values
  (
    'wristbands.view',
    'Ver pulseiras',
    'Visualizar pulseiras vinculadas aos ingressos.',
    'wristbands',
    10,
    true
  ),
  (
    'wristbands.link',
    'Vincular pulseiras',
    'Vincular uma pulseira disponível a um ingresso.',
    'wristbands',
    20,
    true
  ),
  (
    'wristbands.unlink',
    'Desvincular pulseiras',
    'Desvincular uma pulseira ativa de um ingresso.',
    'wristbands',
    30,
    true
  ),
  (
    'wristbands.replace',
    'Substituir pulseiras',
    'Substituir uma pulseira perdida, danificada ou incorreta.',
    'wristbands',
    40,
    true
  ),
  (
    'wristbands.block',
    'Bloquear pulseiras',
    'Bloquear uma pulseira para impedir sua utilização.',
    'wristbands',
    50,
    true
  )
on conflict (code)
do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = true;

-- =========================================================
-- TABELA DE PULSEIRAS
-- =========================================================

create table if not exists public.participant_wristbands (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  participant_id uuid references public.participants(id) on delete set null,
  code text not null,
  status text not null default 'active'
    check (status in ('active', 'blocked', 'lost', 'replaced', 'unlinked')),
  linked_at timestamptz not null default now(),
  linked_by uuid references auth.users(id) on delete set null,
  unlinked_at timestamptz,
  unlinked_by uuid references auth.users(id) on delete set null,
  replaced_by_wristband_id uuid references public.participant_wristbands(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists participant_wristbands_event_code_active_uidx
on public.participant_wristbands (event_id, lower(code))
where status = 'active';

create unique index if not exists participant_wristbands_ticket_active_uidx
on public.participant_wristbands (ticket_id)
where status = 'active';

create index if not exists participant_wristbands_participant_idx
on public.participant_wristbands (participant_id);

create index if not exists participant_wristbands_event_idx
on public.participant_wristbands (event_id);

alter table public.participant_wristbands enable row level security;

drop policy if exists participant_wristbands_rbac_select
on public.participant_wristbands;

create policy participant_wristbands_rbac_select
on public.participant_wristbands
for select
to authenticated
using (
  public.is_active_owner(auth.uid())
  or public.resolve_user_permission(auth.uid(), 'wristbands.view')
  or public.resolve_user_permission(auth.uid(), 'wristbands.link')
  or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
  or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
  or public.resolve_user_permission(auth.uid(), 'wristbands.block')
  or public.resolve_user_permission(auth.uid(), 'kits.view')
  or public.resolve_user_permission(auth.uid(), 'checkin.view')
);

drop policy if exists participant_wristbands_rbac_insert
on public.participant_wristbands;

create policy participant_wristbands_rbac_insert
on public.participant_wristbands
for insert
to authenticated
with check (
  public.is_active_owner(auth.uid())
  or public.resolve_user_permission(auth.uid(), 'wristbands.link')
  or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
);

drop policy if exists participant_wristbands_rbac_update
on public.participant_wristbands;

create policy participant_wristbands_rbac_update
on public.participant_wristbands
for update
to authenticated
using (
  public.is_active_owner(auth.uid())
  or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
  or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
  or public.resolve_user_permission(auth.uid(), 'wristbands.block')
)
with check (
  public.is_active_owner(auth.uid())
  or public.resolve_user_permission(auth.uid(), 'wristbands.unlink')
  or public.resolve_user_permission(auth.uid(), 'wristbands.replace')
  or public.resolve_user_permission(auth.uid(), 'wristbands.block')
);

-- =========================================================
-- FUNÇÃO: VINCULAR PULSEIRA
-- =========================================================

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
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_existing public.participant_wristbands%rowtype;
  v_wristband public.participant_wristbands%rowtype;
  v_code text := nullif(trim(p_code), '');
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

  select t.*
  into v_ticket
  from public.tickets t
  where t.id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.participant_id is null then
    raise exception 'Ingresso ainda nao possui participante vinculado.';
  end if;

  select p.*
  into v_participant
  from public.participants p
  where p.id = v_ticket.participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select e.*
  into v_event
  from public.events e
  where e.id = v_participant.event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.wristband_enabled, false) then
    raise exception 'Este evento nao utiliza pulseiras vinculadas.';
  end if;

  select pw.*
  into v_existing
  from public.participant_wristbands pw
  where pw.event_id = v_participant.event_id
    and lower(pw.code) = lower(v_code)
    and pw.status = 'active'
  limit 1
  for update;

  if found then
    if v_existing.ticket_id = p_ticket_id then
      return jsonb_build_object(
        'success', true,
        'already_linked', true,
        'wristband_id', v_existing.id,
        'code', v_existing.code
      );
    end if;

    raise exception 'Pulseira ja vinculada a outro ingresso.';
  end if;

  if exists (
    select 1
    from public.participant_wristbands pw
    where pw.ticket_id = p_ticket_id
      and pw.status = 'active'
  ) then
    raise exception 'Este ingresso ja possui uma pulseira ativa.';
  end if;

  insert into public.participant_wristbands (
    event_id,
    ticket_id,
    participant_id,
    code,
    status,
    linked_at,
    linked_by
  )
  values (
    v_participant.event_id,
    p_ticket_id,
    v_participant.id,
    v_code,
    'active',
    now(),
    auth.uid()
  )
  returning *
  into v_wristband;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  values (
    'wristband_linked',
    'participant_wristbands',
    v_wristband.id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', p_ticket_id,
      'participant_id', v_participant.id,
      'code', v_code
    )
  );

  return jsonb_build_object(
    'success', true,
    'already_linked', false,
    'wristband_id', v_wristband.id,
    'code', v_wristband.code
  );
end;
$function$;

-- =========================================================
-- FUNÇÃO: DESVINCULAR
-- =========================================================

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
  v_wristband public.participant_wristbands%rowtype;
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

  select pw.*
  into v_wristband
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id
    and pw.status = 'active'
  limit 1
  for update;

  if not found then
    raise exception 'Nenhuma pulseira ativa encontrada para este ingresso.';
  end if;

  update public.participant_wristbands pw
  set status = 'unlinked',
      unlinked_at = now(),
      unlinked_by = auth.uid(),
      notes = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at = now()
  where pw.id = v_wristband.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  values (
    'wristband_unlinked',
    'participant_wristbands',
    v_wristband.id,
    v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', p_ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$function$;

-- =========================================================
-- FUNÇÃO: SUBSTITUIR
-- =========================================================

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
  v_old public.participant_wristbands%rowtype;
  v_new_result jsonb;
  v_new_id uuid;
begin
  if not (
    public.is_active_owner(auth.uid())
    or public.current_user_has_permission('wristbands.replace')
  ) then
    raise exception 'Sem permissao para substituir pulseira.';
  end if;

  select pw.*
  into v_old
  from public.participant_wristbands pw
  where pw.ticket_id = p_ticket_id
    and pw.status = 'active'
  limit 1
  for update;

  if found then
    update public.participant_wristbands pw
    set status = 'replaced',
        unlinked_at = now(),
        unlinked_by = auth.uid(),
        notes = nullif(trim(coalesce(p_reason, '')), ''),
        updated_at = now()
    where pw.id = v_old.id;
  end if;

  v_new_result := public.link_wristband_to_ticket(p_ticket_id, p_new_code);
  v_new_id := nullif(v_new_result ->> 'wristband_id', '')::uuid;

  if v_old.id is not null and v_new_id is not null then
    update public.participant_wristbands
    set replaced_by_wristband_id = v_new_id,
        updated_at = now()
    where id = v_old.id;
  end if;

  return v_new_result || jsonb_build_object(
    'replaced_wristband_id', v_old.id
  );
end;
$function$;

-- =========================================================
-- FUNÇÃO: BLOQUEAR
-- =========================================================

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
  v_wristband public.participant_wristbands%rowtype;
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

  select pw.*
  into v_wristband
  from public.participant_wristbands pw
  where pw.id = p_wristband_id
  for update;

  if not found then
    raise exception 'Pulseira nao encontrada.';
  end if;

  if v_wristband.status <> 'active' then
    raise exception 'Somente pulseira ativa pode ser bloqueada.';
  end if;

  update public.participant_wristbands pw
  set status = 'blocked',
      notes = nullif(trim(coalesce(p_reason, '')), ''),
      updated_at = now()
  where pw.id = p_wristband_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  )
  values (
    'wristband_blocked',
    'participant_wristbands',
    p_wristband_id,
    v_wristband.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_wristband.ticket_id,
      'participant_id', v_wristband.participant_id,
      'code', v_wristband.code,
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  return true;
end;
$function$;

grant execute on function public.link_wristband_to_ticket(uuid, text)
to authenticated;

grant execute on function public.unlink_wristband_from_ticket(uuid, text)
to authenticated;

grant execute on function public.replace_wristband_for_ticket(uuid, text, text)
to authenticated;

grant execute on function public.block_wristband(uuid, text)
to authenticated;

commit;