-- Modulo de Feedback / Reportar problema (fase beta).
--
-- Arquitetura reaproveitada (mesmo padrao do modulo de patrocinadores):
-- - admin_permissions/admin_role_permissions + current_user_has_permission():
--   feedback.view/feedback.manage seguem exatamente o padrao de
--   sponsors.view/sponsors.manage.
-- - organization_id nunca vem do client: resolvido no servidor. Como o
--   sistema ainda opera como uma unica organizacao "principal" por instalacao
--   (mesma convencao pragmatica documentada em get_active_sponsors_for_home/
--   get_featured_events_for_dashboard) e um relato de feedback pode ser
--   aberto de qualquer pagina (sem evento/pedido de referencia obrigatorio),
--   resolve-se a unica organizacao existente -- quando o NEXORA multi-tenant
--   precisar de outra fonte (org do dominio visitado, por exemplo), e uma
--   troca isolada dentro de submit_user_feedback, sem tocar schema/RLS.
-- - audit_logs (action/entity_type/entity_id/event_id/details com
--   actor_user_id): mesma convencao ja usada no restante do sistema.
--
-- Diferenca deliberada do padrao de sponsors: SELECT em user_feedback e
-- restrito a staff (organizacao + feedback.view), sem branch "user_id =
-- auth.uid()". O usuario comum ainda pode ENVIAR (via RPC), mas nao ha ainda
-- uma tela de "meus relatos" nesta entrega -- se um dia existir, deve ler por
-- uma RPC propria que devolve so os campos do proprio usuario (nunca
-- admin_notes/resolved_by), nao por uma policy ampla de SELECT direto na
-- tabela, que vazaria essas colunas internas para qualquer client autenticado.
begin;

-- ============================================================
-- 1. Tabela user_feedback
-- ============================================================

create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('problem', 'suggestion', 'question')),
  message text not null check (length(message) between 1 and 4000),
  screenshot_path text,
  page_path text,
  event_id uuid references public.events(id) on delete set null,
  technical_context jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'reviewing', 'resolved', 'ignored')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_user_feedback_org_status_created on public.user_feedback (organization_id, status, created_at desc);
create index if not exists idx_user_feedback_user on public.user_feedback (user_id, created_at desc);
create index if not exists idx_user_feedback_event on public.user_feedback (event_id) where event_id is not null;

alter table public.user_feedback enable row level security;

drop policy if exists "user_feedback_select_staff" on public.user_feedback;
create policy "user_feedback_select_staff" on public.user_feedback for select to authenticated
  using (
    public.user_can_access_organization(auth.uid(), organization_id)
    and public.current_user_has_permission('feedback.view')
  );

-- Nenhuma policy de insert/update/delete: toda escrita passa pelas RPCs
-- security definer abaixo (mesmo padrao de sponsors/store).

-- ============================================================
-- 2. Bucket de storage privado "feedback-screenshots"
--
-- Primeiro bucket privado do sistema (event-banners/store-item-images/
-- sponsor-banners sao todos public=true). Como o anexo pode conter dados
-- sensiveis capturados em tela pelo usuario, a leitura NUNCA e por URL
-- publica: sempre por signed URL, gerada a partir do client autenticado do
-- proprio servidor (createServerSupabaseClient, com a sessao do usuario) --
-- o Storage aplica a policy de SELECT abaixo tambem para geracao de signed
-- URL, entao a mesma fronteira de autorizacao vale para as duas operacoes.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-screenshots', 'feedback-screenshots', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: "{user_id}/{arquivo}" -- o proprio usuario so escreve na
-- propria pasta (fronteira real, nao so de UI). Leitura: o dono sempre pode
-- ver o proprio anexo; staff so ve quando o anexo pertence a um feedback de
-- uma organizacao que o staff acessa e com feedback.view -- casado pelo
-- screenshot_path exato da linha em user_feedback, nunca so pela pasta.
drop policy if exists "feedback_screenshots_owner_insert" on storage.objects;
create policy "feedback_screenshots_owner_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'feedback-screenshots'
  and (storage.foldername(storage.objects.name))[1] = auth.uid()::text
);

drop policy if exists "feedback_screenshots_owner_or_staff_select" on storage.objects;
create policy "feedback_screenshots_owner_or_staff_select"
on storage.objects for select
to authenticated
using (
  bucket_id = 'feedback-screenshots'
  and (
    (storage.foldername(storage.objects.name))[1] = auth.uid()::text
    or exists (
      select 1 from public.user_feedback f
      where f.screenshot_path = storage.objects.name
        and public.user_can_access_organization(auth.uid(), f.organization_id)
        and public.current_user_has_permission('feedback.view')
    )
  )
);

-- Sem update/delete: o anexo e enviado uma unica vez no momento do relato
-- (upload opcional de 1 imagem), nunca substituido depois.

-- ============================================================
-- 3. Permissoes (mesmo padrao de sponsors.view/sponsors.manage)
-- ============================================================

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('feedback.view', 'Ver feedbacks', 'Visualiza relatos de problema, sugestao e duvida enviados pelos usuarios', 'feedback', 10, true),
  ('feedback.manage', 'Gerenciar feedbacks', 'Altera status e adiciona observacao interna aos relatos de feedback', 'feedback', 20, true)
on conflict (code) do update set name = excluded.name, description = excluded.description, module = excluded.module, sort_order = excluded.sort_order, is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id
from public.admin_roles ar
join public.admin_permissions ap on ap.code in ('feedback.view', 'feedback.manage')
where ar.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 4. RPC de envio (qualquer usuario autenticado)
-- ============================================================

-- p_event_slug_hint: nunca aceita event_id direto do client. O client so
-- pode sugerir um slug extraido da propria URL corrente; o RPC resolve para
-- um event_id real (ou deixa null se o slug nao existir) -- "determinar com
-- seguranca" significa: a ligacao com o evento so acontece se o slug bater
-- com um evento que realmente existe, nunca por um id inventado/adivinhado.
create or replace function public.submit_user_feedback(
  p_type text,
  p_message text,
  p_screenshot_path text default null,
  p_page_path text default null,
  p_event_slug_hint text default null,
  p_technical_context jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_event_id uuid;
  v_type text := lower(trim(coalesce(p_type, '')));
  v_message text := trim(coalesce(p_message, ''));
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  if v_type not in ('problem', 'suggestion', 'question') then raise exception 'Tipo de feedback invalido.'; end if;
  if v_message = '' then raise exception 'Descreva o que aconteceu.'; end if;
  if length(v_message) > 4000 then raise exception 'Mensagem muito longa (maximo 4000 caracteres).'; end if;

  -- Pragmatico single-org: ver nota no topo do arquivo.
  select id into v_org from public.organizations order by created_at limit 1;
  if v_org is null then raise exception 'Nenhuma organizacao configurada.'; end if;

  if p_screenshot_path is not null and (storage.foldername(p_screenshot_path))[1] is distinct from v_actor::text then
    raise exception 'Anexo invalido para este usuario.';
  end if;

  if nullif(trim(coalesce(p_event_slug_hint, '')), '') is not null then
    select id into v_event_id from public.events where slug = trim(p_event_slug_hint) limit 1;
  end if;

  insert into public.user_feedback (organization_id, user_id, type, message, screenshot_path, page_path, event_id, technical_context)
  values (v_org, v_actor, v_type, v_message, p_screenshot_path, nullif(trim(coalesce(p_page_path, '')), ''), v_event_id, coalesce(p_technical_context, '{}'::jsonb))
  returning id into v_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('user_feedback_submitted', 'user_feedback', v_id, v_event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'organization_id', v_org, 'type', v_type, 'has_screenshot', p_screenshot_path is not null));

  return v_id;
end; $$;

revoke all on function public.submit_user_feedback(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_user_feedback(text, text, text, text, text, jsonb) to authenticated;

-- ============================================================
-- 5. RPCs administrativas (staff da organizacao, feedback.view/feedback.manage)
-- ============================================================

create or replace function public.list_feedback_for_admin(
  p_organization_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_from timestamptz default null,
  p_to timestamptz default null
) returns table(
  feedback_id uuid, type text, message text, status text, page_path text, has_screenshot boolean,
  user_id uuid, user_full_name text, user_email text, event_id uuid, event_name text, created_at timestamptz
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('feedback.view') then
    raise exception 'Sem permissao para ver feedbacks.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;

  return query
  select f.id, f.type, f.message, f.status, f.page_path, (f.screenshot_path is not null),
    f.user_id, coalesce(nullif(trim(cp.full_name), ''), nullif(trim(au.raw_user_meta_data->>'full_name'), '')),
    au.email::text, f.event_id, e.name, f.created_at
  from public.user_feedback f
  left join auth.users au on au.id = f.user_id
  left join public.customer_profiles cp on cp.user_id = f.user_id
  left join public.events e on e.id = f.event_id
  where f.organization_id = v_org
    and (p_status is null or f.status = p_status)
    and (p_type is null or f.type = p_type)
    and (p_from is null or f.created_at >= p_from)
    and (p_to is null or f.created_at <= p_to)
  order by f.created_at desc
  limit 200;
end; $$;

revoke all on function public.list_feedback_for_admin(uuid, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.list_feedback_for_admin(uuid, text, text, timestamptz, timestamptz) to authenticated;

create or replace function public.get_feedback_detail_for_admin(p_feedback_id uuid)
returns table(
  feedback_id uuid, organization_id uuid, type text, message text, status text, admin_notes text,
  page_path text, screenshot_path text, technical_context jsonb, event_id uuid, event_name text,
  user_id uuid, user_full_name text, user_email text, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz, resolved_by uuid, resolved_by_name text
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_feedback public.user_feedback%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('feedback.view') then
    raise exception 'Sem permissao para ver feedbacks.';
  end if;
  select * into v_feedback from public.user_feedback where id = p_feedback_id;
  if not found or not public.user_can_access_organization(v_actor, v_feedback.organization_id) then
    raise exception 'Feedback nao encontrado.';
  end if;

  return query
  select f.id, f.organization_id, f.type, f.message, f.status, f.admin_notes, f.page_path, f.screenshot_path,
    f.technical_context, f.event_id, e.name, f.user_id,
    coalesce(nullif(trim(cp.full_name), ''), nullif(trim(au.raw_user_meta_data->>'full_name'), '')), au.email::text,
    f.created_at, f.updated_at, f.resolved_at, f.resolved_by,
    coalesce(nullif(trim(rcp.full_name), ''), nullif(trim(rau.raw_user_meta_data->>'full_name'), ''))
  from public.user_feedback f
  left join auth.users au on au.id = f.user_id
  left join public.customer_profiles cp on cp.user_id = f.user_id
  left join public.events e on e.id = f.event_id
  left join auth.users rau on rau.id = f.resolved_by
  left join public.customer_profiles rcp on rcp.user_id = f.resolved_by
  where f.id = p_feedback_id;
end; $$;

revoke all on function public.get_feedback_detail_for_admin(uuid) from public, anon;
grant execute on function public.get_feedback_detail_for_admin(uuid) to authenticated;

create or replace function public.update_feedback_status(p_feedback_id uuid, p_status text, p_admin_notes text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_feedback public.user_feedback%rowtype; v_status text := lower(trim(coalesce(p_status, '')));
begin
  if v_actor is null or not public.current_user_has_permission('feedback.manage') then
    raise exception 'Sem permissao para gerenciar feedbacks.';
  end if;
  if v_status not in ('new', 'reviewing', 'resolved', 'ignored') then raise exception 'Status invalido.'; end if;

  select * into v_feedback from public.user_feedback where id = p_feedback_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_feedback.organization_id) then
    raise exception 'Feedback nao encontrado.';
  end if;

  update public.user_feedback set
    status = v_status,
    admin_notes = coalesce(nullif(trim(p_admin_notes), ''), admin_notes),
    resolved_at = case when v_status in ('resolved', 'ignored') then coalesce(resolved_at, now()) else null end,
    resolved_by = case when v_status in ('resolved', 'ignored') then v_actor else null end,
    updated_at = now()
  where id = p_feedback_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('user_feedback_status_updated', 'user_feedback', p_feedback_id, v_feedback.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'organization_id', v_feedback.organization_id,
    'previous_status', v_feedback.status, 'new_status', v_status));
end; $$;

revoke all on function public.update_feedback_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_feedback_status(uuid, text, text) to authenticated;

commit;
