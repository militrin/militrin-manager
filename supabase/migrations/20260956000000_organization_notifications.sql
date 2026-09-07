-- Central de notificacoes da organizacao.
--
-- Modelo: uma linha por evento de atencao (nao fan-out por destinatario).
-- Leitura por usuario em organization_notification_reads. Quem ve e definido
-- por RLS/RPC (org + permissao do tipo), nunca so pela UI.
--
-- Tipos iniciais: CHANGE_REQUEST_CREATED, FEEDBACK_CREATED.
-- Tipos futuros (PAYMENT_PROBLEM, IMPORT_REVIEW_REQUIRED, STOCK_LOW, ...)
-- entram no check da coluna type sem mudar a tabela de leituras.
--
-- Idempotencia: unique (organization_id, type, entity_id) -- retry/reload
-- da origem nao duplica a notificacao.
begin;

create table if not exists public.organization_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  entity_type text,
  entity_id uuid not null,
  action_href text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint organization_notifications_type_check check (type in (
    'CHANGE_REQUEST_CREATED',
    'FEEDBACK_CREATED'
  )),
  constraint organization_notifications_title_len check (length(title) between 1 and 200),
  constraint organization_notifications_body_len check (length(body) between 1 and 2000)
);

create unique index if not exists ux_organization_notifications_org_type_entity
  on public.organization_notifications (organization_id, type, entity_id);

create index if not exists idx_organization_notifications_org_created
  on public.organization_notifications (organization_id, created_at desc);

create index if not exists idx_organization_notifications_event
  on public.organization_notifications (event_id, created_at desc)
  where event_id is not null;

comment on table public.organization_notifications is
  'Mecanismo de atencao/navegacao da organizacao. Nao substitui audit_logs nem o historico da entidade de origem.';

create table if not exists public.organization_notification_reads (
  notification_id uuid not null references public.organization_notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create index if not exists idx_organization_notification_reads_user
  on public.organization_notification_reads (user_id, read_at desc);

alter table public.organization_notifications enable row level security;
alter table public.organization_notification_reads enable row level security;

-- Quem pode ver uma notificacao: acesso a org E permissao do tipo.
create or replace function public.user_can_view_organization_notification(p_user_id uuid, p_notification public.organization_notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and public.user_can_access_organization(p_user_id, p_notification.organization_id)
    and case p_notification.type
      when 'CHANGE_REQUEST_CREATED' then public.user_has_permission(p_user_id, 'kits.deliver')
      when 'FEEDBACK_CREATED' then public.user_has_permission(p_user_id, 'feedback.view')
      else false
    end;
$$;

revoke all on function public.user_can_view_organization_notification(uuid, public.organization_notifications) from public, anon;
grant execute on function public.user_can_view_organization_notification(uuid, public.organization_notifications) to authenticated, service_role;

drop policy if exists "organization_notifications_select_authorized" on public.organization_notifications;
create policy "organization_notifications_select_authorized"
  on public.organization_notifications
  for select
  to authenticated
  using (public.user_can_view_organization_notification(auth.uid(), organization_notifications));

drop policy if exists "organization_notification_reads_select_own" on public.organization_notification_reads;
create policy "organization_notification_reads_select_own"
  on public.organization_notification_reads
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.organization_notifications n
      where n.id = notification_id
        and public.user_can_view_organization_notification(auth.uid(), n)
    )
  );

-- Escrita so via RPC/trigger (security definer). Sem policies de insert/update/delete.

grant select on public.organization_notifications to authenticated, service_role;
grant select on public.organization_notification_reads to authenticated, service_role;


create or replace function public.list_organization_notifications(
  p_read_state text default 'all',
  p_type text default null,
  p_limit integer default 20,
  p_offset integer default 0
) returns table(
  notification_id uuid,
  type text,
  title text,
  body text,
  action_href text,
  entity_type text,
  entity_id uuid,
  event_id uuid,
  created_at timestamptz,
  read_at timestamptz,
  is_unread boolean,
  total_count integer
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_state text := lower(trim(coalesce(p_read_state, 'all')));
  v_type text := nullif(upper(trim(coalesce(p_type, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if v_state not in ('all', 'unread', 'read') then
    raise exception 'Filtro de leitura invalido.';
  end if;
  if v_type is not null and v_type not in ('CHANGE_REQUEST_CREATED', 'FEEDBACK_CREATED') then
    raise exception 'Tipo de notificacao invalido.';
  end if;

  return query
  with visible as (
    select n.*, r.read_at as user_read_at
    from public.organization_notifications n
    left join public.organization_notification_reads r
      on r.notification_id = n.id and r.user_id = v_actor
    where n.organization_id = v_org
      and public.user_can_view_organization_notification(v_actor, n)
      and (v_type is null or n.type = v_type)
      and (
        v_state = 'all'
        or (v_state = 'unread' and r.read_at is null)
        or (v_state = 'read' and r.read_at is not null)
      )
  )
  select
    v.id, v.type, v.title, v.body, v.action_href, v.entity_type, v.entity_id, v.event_id, v.created_at,
    v.user_read_at, (v.user_read_at is null), (count(*) over ())::integer
  from visible v
  order by v.created_at desc, v.id desc
  limit v_limit offset v_offset;
end; $$;

revoke all on function public.list_organization_notifications(text, text, integer, integer) from public, anon;
grant execute on function public.list_organization_notifications(text, text, integer, integer) to authenticated, service_role;


create or replace function public.count_unread_organization_notifications()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_count integer := 0;
begin
  if v_actor is null then return 0; end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    return 0;
  end if;

  select count(*)::integer into v_count
  from public.organization_notifications n
  where n.organization_id = v_org
    and public.user_can_view_organization_notification(v_actor, n)
    and not exists (
      select 1 from public.organization_notification_reads r
      where r.notification_id = n.id and r.user_id = v_actor
    );
  return coalesce(v_count, 0);
end; $$;

revoke all on function public.count_unread_organization_notifications() from public, anon;
grant execute on function public.count_unread_organization_notifications() to authenticated, service_role;


create or replace function public.mark_organization_notification_read(p_notification_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_row public.organization_notifications%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_row from public.organization_notifications where id = p_notification_id;
  if not found or not public.user_can_view_organization_notification(v_actor, v_row) then
    raise exception 'Notificacao nao encontrada.';
  end if;

  insert into public.organization_notification_reads (notification_id, user_id, read_at)
  values (p_notification_id, v_actor, now())
  on conflict (notification_id, user_id) do nothing;
  return true;
end; $$;

revoke all on function public.mark_organization_notification_read(uuid) from public, anon;
grant execute on function public.mark_organization_notification_read(uuid) to authenticated, service_role;


create or replace function public.mark_all_organization_notifications_read()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_count integer := 0;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  insert into public.organization_notification_reads (notification_id, user_id, read_at)
  select n.id, v_actor, now()
  from public.organization_notifications n
  where n.organization_id = v_org
    and public.user_can_view_organization_notification(v_actor, n)
    and not exists (
      select 1 from public.organization_notification_reads r
      where r.notification_id = n.id and r.user_id = v_actor
    )
  on conflict (notification_id, user_id) do nothing;
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end; $$;

revoke all on function public.mark_all_organization_notifications_read() from public, anon;
grant execute on function public.mark_all_organization_notifications_read() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Origem: solicitacao de alteracao
-- ---------------------------------------------------------------------------
create or replace function public.notify_ticket_item_change_request_created()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_ref text;
  v_display bigint;
  v_position integer;
  v_order_number text;
begin
  select coalesce(
    nullif(trim(cp.full_name), ''),
    nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
    'Um participante'
  )
  into v_name
  from auth.users au
  left join public.customer_profiles cp on cp.user_id = au.id
  where au.id = new.requested_by;

  select o.display_number, oi.item_position, o.order_number
  into v_display, v_position, v_order_number
  from public.tickets t
  left join public.orders o on o.id = t.order_id
  left join public.order_items oi on oi.id = t.order_item_id
  where t.id = new.ticket_id;

  v_ref := case
    when v_display is not null and v_display > 0 and v_position is not null and v_position > 0
      then '#' || lpad(v_display::text, 6, '0') || '-' || lpad(v_position::text, 2, '0')
    when v_display is not null and v_display > 0
      then '#' || lpad(v_display::text, 6, '0')
    else coalesce(nullif(trim(v_order_number), ''), 'sem número')
  end;

  insert into public.organization_notifications (
    organization_id, event_id, type, title, body, entity_type, entity_id, action_href, created_by
  ) values (
    new.organization_id,
    new.event_id,
    'CHANGE_REQUEST_CREATED',
    'Nova solicitação de alteração',
    coalesce(v_name, 'Um participante') || ' solicitou alteração no ingresso ' || v_ref || '.',
    'ticket_item_change_requests',
    new.id,
    '/operacoes/solicitacoes?requestId=' || new.id::text,
    new.requested_by
  )
  on conflict (organization_id, type, entity_id) do nothing;

  return new;
end; $$;

drop trigger if exists trg_notify_ticket_item_change_request_created on public.ticket_item_change_requests;
create trigger trg_notify_ticket_item_change_request_created
after insert on public.ticket_item_change_requests
for each row execute function public.notify_ticket_item_change_request_created();


-- ---------------------------------------------------------------------------
-- Origem: feedback
-- ---------------------------------------------------------------------------
create or replace function public.notify_user_feedback_created()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event_name text;
  v_body text;
begin
  if new.event_id is not null then
    select e.name into v_event_name from public.events e where e.id = new.event_id;
  end if;

  v_body := case
    when nullif(trim(coalesce(v_event_name, '')), '') is not null
      then 'Foi enviado um novo feedback sobre o evento ' || v_event_name || '.'
    else 'Foi enviado um novo feedback.'
  end;

  insert into public.organization_notifications (
    organization_id, event_id, type, title, body, entity_type, entity_id, action_href, created_by
  ) values (
    new.organization_id,
    new.event_id,
    'FEEDBACK_CREATED',
    'Novo feedback recebido',
    v_body,
    'user_feedback',
    new.id,
    '/painel/feedbacks?feedbackId=' || new.id::text,
    new.user_id
  )
  on conflict (organization_id, type, entity_id) do nothing;

  return new;
end; $$;

drop trigger if exists trg_notify_user_feedback_created on public.user_feedback;
create trigger trg_notify_user_feedback_created
after insert on public.user_feedback
for each row execute function public.notify_user_feedback_created();


-- Realtime: INSERT na tabela de notificacoes atualiza o sininho sem refresh.
alter table public.organization_notifications replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.organization_notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

commit;
