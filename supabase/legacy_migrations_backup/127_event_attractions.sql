-- 127_event_attractions.sql
-- Atracoes do evento (line-up): o admin cadastra atracoes por evento, cada
-- uma com um banner opcional. O link publico "Ver atracoes" so aparece na
-- pagina do evento quando existir pelo menos uma atracao ativa cadastrada.
--
-- Mesmo padrao de event_kit_items (015): tabela com RLS de leitura publica
-- (using (true), sem exigir RPC pra listar) e escrita exclusiva via RPC
-- security definer. Diferente do event_kit_items, aqui a escrita exige
-- current_user_has_permission('events.edit') explicitamente, seguindo o
-- padrao mais estrito usado em create_event/update_event/archive_event.
--
-- Banner reaproveita o bucket "event-banners" (ja criado e com policies
-- desde a 126) -- nao precisa de bucket novo.

begin;

create table if not exists public.event_attractions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  description text,
  banner_url text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_event_attractions_event_active
  on public.event_attractions (event_id, is_active, sort_order);

alter table public.event_attractions enable row level security;

drop policy if exists "event_attractions_read_only" on public.event_attractions;
create policy "event_attractions_read_only"
on public.event_attractions
for select
to anon, authenticated
using (true);

create or replace function public.upsert_event_attraction(
  p_id uuid default null,
  p_event_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_banner_url text default null,
  p_is_active boolean default true,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_id uuid := p_id;
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if not public.current_user_has_permission('events.edit') then
    raise exception 'Permissao insuficiente para gerenciar atracoes.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome da atracao obrigatorio.';
  end if;

  if v_id is null then
    insert into public.event_attractions (
      event_id, name, description, banner_url, is_active, sort_order
    ) values (
      p_event_id,
      trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''),
      nullif(trim(coalesce(p_banner_url, '')), ''),
      coalesce(p_is_active, true),
      coalesce(p_sort_order, 0)
    )
    returning id into v_id;
  else
    update public.event_attractions
    set name = trim(p_name),
        description = nullif(trim(coalesce(p_description, '')), ''),
        banner_url = nullif(trim(coalesce(p_banner_url, '')), ''),
        is_active = coalesce(p_is_active, true),
        sort_order = coalesce(p_sort_order, 0),
        updated_at = now()
    where id = v_id
      and event_id = p_event_id;

    if not found then
      raise exception 'Atracao nao encontrada para o evento.';
    end if;
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, event_id, details
  ) values (
    case when p_id is null then 'event_attraction_created' else 'event_attraction_updated' end,
    'event_attractions',
    v_id,
    p_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    )
  );

  return v_id;
end;
$$;

revoke all on function public.upsert_event_attraction(uuid, uuid, text, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.upsert_event_attraction(uuid, uuid, text, text, text, boolean, integer) to authenticated;

create or replace function public.delete_event_attraction(
  p_event_id uuid,
  p_attraction_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
begin
  if v_actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  if not public.current_user_has_permission('events.edit') then
    raise exception 'Permissao insuficiente para gerenciar atracoes.';
  end if;

  if p_event_id is null or p_attraction_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  delete from public.event_attractions
  where id = p_attraction_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Atracao nao encontrada para o evento.';
  end if;

  insert into public.audit_logs (
    action, entity_type, entity_id, event_id, details
  ) values (
    'event_attraction_deleted', 'event_attractions', p_attraction_id, p_event_id, '{}'::jsonb
  );

  return true;
end;
$$;

revoke all on function public.delete_event_attraction(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_event_attraction(uuid, uuid) to authenticated;

commit;
