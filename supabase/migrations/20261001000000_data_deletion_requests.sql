begin;

-- Solicitações públicas de exclusão de dados (LGPD / Meta).
-- Este fluxo NÃO apaga automaticamente contas, ingressos, pedidos ou
-- dados de Instagram. Apenas registra um pedido para análise posterior.

create table if not exists public.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  requester_name text not null,
  requester_email text not null,
  instagram_handle text,
  notes text,
  confirmation_accepted boolean not null,
  status text not null default 'received'
    check (status in ('received', 'in_review', 'completed', 'rejected')),
  user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_deletion_requests_name_len check (char_length(requester_name) between 2 and 120),
  constraint data_deletion_requests_email_len check (char_length(requester_email) between 3 and 254),
  constraint data_deletion_requests_handle_len check (instagram_handle is null or char_length(instagram_handle) between 1 and 30),
  constraint data_deletion_requests_notes_len check (notes is null or char_length(notes) <= 2000)
);

create index if not exists data_deletion_requests_email_created_idx
  on public.data_deletion_requests (requester_email, created_at desc);

create index if not exists data_deletion_requests_org_created_idx
  on public.data_deletion_requests (organization_id, created_at desc);

alter table public.data_deletion_requests enable row level security;
revoke all on public.data_deletion_requests from public, anon, authenticated;
grant all on public.data_deletion_requests to service_role;

create or replace function public.submit_data_deletion_request(
  p_full_name text,
  p_email text,
  p_instagram_handle text default null,
  p_notes text default null,
  p_confirmed boolean default false,
  p_website text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
  v_name text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_handle text := nullif(btrim(regexp_replace(coalesce(p_instagram_handle, ''), '^@+', '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_recent integer;
begin
  -- Honeypot: formulários preenchidos por automação trivial não gravam pedido.
  if nullif(btrim(coalesce(p_website, '')), '') is not null then
    return gen_random_uuid();
  end if;

  if coalesce(p_confirmed, false) is not true then
    raise exception 'Confirme que deseja solicitar a exclusao dos dados.';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Informe seu nome completo.';
  end if;
  if v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(v_email) > 254 then
    raise exception 'Informe um e-mail valido.';
  end if;
  if v_handle is not null and v_handle !~ '^[A-Za-z0-9._]{1,30}$' then
    raise exception 'Informe um usuario do Instagram valido, ou deixe o campo em branco.';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'As observacoes podem ter no maximo 2000 caracteres.';
  end if;

  -- Pragmatico single-org: o cliente nao escolhe a organizacao.
  select id into v_org from public.organizations order by created_at limit 1;
  if v_org is null then raise exception 'Nenhuma organizacao configurada.'; end if;

  select count(*) into v_recent
  from public.data_deletion_requests
  where requester_email = v_email
    and created_at > now() - interval '24 hours';
  if coalesce(v_recent, 0) > 0 then
    raise exception 'Ja registramos uma solicitacao recente para este e-mail. Ela sera analisada; nao e necessario enviar de novo agora.';
  end if;

  insert into public.data_deletion_requests (
    organization_id,
    requester_name,
    requester_email,
    instagram_handle,
    notes,
    confirmation_accepted,
    status,
    user_id
  ) values (
    v_org,
    v_name,
    v_email,
    v_handle,
    v_notes,
    true,
    'received',
    auth.uid()
  )
  returning id into v_id;

  insert into public.audit_logs (action, entity_type, entity_id, details)
  values (
    'data_deletion_request_submitted',
    'data_deletion_request',
    v_id,
    jsonb_build_object('organization_id', v_org)
  );

  return v_id;
end;
$$;

revoke all on function public.submit_data_deletion_request(text, text, text, text, boolean, text) from public;
grant execute on function public.submit_data_deletion_request(text, text, text, text, boolean, text) to anon, authenticated;

commit;
