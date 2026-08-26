begin;

-- Fase 1 Asaas -- tabela canonica de eventos de webhook de gateway de
-- pagamento, com idempotencia. Webhooks de gateway (Asaas confirmado na
-- documentacao oficial, e gateways em geral) sao "at-least-once": o mesmo
-- evento pode chegar 2x, 10x, ou em requests concorrentes. Esta tabela + a
-- funcao `record_payment_gateway_event` abaixo replicam o padrao de
-- idempotencia ja usado em `financial_entries` (UNIQUE + upsert-or-return com
-- fallback em EXCEPTION WHEN unique_violation para a corrida entre o SELECT
-- de checagem e o INSERT).

create table if not exists public.payment_gateway_events (
  id uuid default gen_random_uuid() not null primary key,
  organization_id uuid references public.organizations(id),
  provider text not null,
  external_event_id text not null,
  event_type text not null,
  provider_payment_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received',
  attempt_count integer not null default 0,
  last_error text,
  constraint payment_gateway_events_provider_check check (provider in ('fake','asaas')),
  constraint payment_gateway_events_processing_status_check
    check (processing_status in ('received','processing','processed','failed','ignored')),
  constraint payment_gateway_events_attempt_count_check check (attempt_count >= 0),
  constraint payment_gateway_events_provider_external_event_id_key unique (provider, external_event_id)
);

create index if not exists idx_payment_gateway_events_provider_payment_id
  on public.payment_gateway_events (provider, provider_payment_id)
  where provider_payment_id is not null;

create index if not exists idx_payment_gateway_events_pending
  on public.payment_gateway_events (processing_status, received_at)
  where processing_status in ('received', 'failed');

create index if not exists idx_payment_gateway_events_organization_id
  on public.payment_gateway_events (organization_id)
  where organization_id is not null;

comment on table public.payment_gateway_events is 'Log idempotente de todo evento de webhook de gateway de pagamento recebido. Nunca deletar linhas -- e o registro de auditoria de "o que a Asaas nos disse e quando".';
comment on column public.payment_gateway_events.external_event_id is 'Id do evento no gateway (ex.: campo "id" do payload de webhook da Asaas). Par (provider, external_event_id) e UNIQUE: mesmo evento entregue N vezes gera 1 unica linha.';
comment on column public.payment_gateway_events.processing_status is 'received: gravado, aguardando processar. processing: sendo processado agora (lock logico). processed: processado com sucesso (idempotente re-consultar). failed: processado com erro, pode reprocessar. ignored: evento reconhecido mas deliberadamente nao processado (ex.: tipo de evento nao relevante).';

alter table public.payment_gateway_events enable row level security;
-- Nenhuma policy para anon/authenticated: e um log interno de infraestrutura,
-- acessado exclusivamente via service_role (bypassa RLS) a partir da rota de
-- webhook server-side e das funcoes SECURITY DEFINER abaixo.

-- ============================================================
-- record_payment_gateway_event: registra o evento de forma idempotente.
-- Retorna is_new=true na primeira vez que o (provider, external_event_id) e
-- visto; nas chamadas seguintes (retry/duplicata) retorna is_new=false com o
-- id ja existente, sem inserir linha nova. O chamador (rota de webhook) so
-- deve prosseguir com o processamento de negocio quando is_new=true --
-- caso contrario o evento ja foi (ou esta sendo) tratado.
-- ============================================================
create or replace function public.record_payment_gateway_event(
  p_provider text,
  p_external_event_id text,
  p_event_type text,
  p_provider_payment_id text,
  p_payload jsonb,
  p_organization_id uuid default null
)
returns table(id uuid, is_new boolean)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_id uuid;
begin
  if p_provider is null or p_provider not in ('fake','asaas') then
    raise exception 'Provider invalido.';
  end if;
  if nullif(trim(coalesce(p_external_event_id,'')),'') is null then
    raise exception 'external_event_id obrigatorio.';
  end if;

  select pge.id into v_id
  from public.payment_gateway_events pge
  where pge.provider = p_provider and pge.external_event_id = p_external_event_id;

  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  insert into public.payment_gateway_events(
    organization_id, provider, external_event_id, event_type, provider_payment_id, payload
  ) values (
    p_organization_id, p_provider, p_external_event_id, p_event_type, p_provider_payment_id, p_payload
  )
  returning payment_gateway_events.id into v_id;

  return query select v_id, true;
exception when unique_violation then
  select pge.id into v_id
  from public.payment_gateway_events pge
  where pge.provider = p_provider and pge.external_event_id = p_external_event_id;
  return query select v_id, false;
end;
$$;

-- ============================================================
-- claim_payment_gateway_event_for_processing: transicao atomica
-- received/failed -> processing. Retorna true so para quem "ganhou" a
-- corrida -- cobre tanto duas entregas simultaneas do MESMO webhook
-- (Asaas reenviando por timeout, por exemplo) quanto dois requests HTTP
-- concorrentes processando o mesmo evento ja gravado. Quem recebe false nao
-- deve executar nenhuma logica de negocio -- so responder 200 e sair (o
-- evento ja esta sendo ou ja foi tratado por outra chamada).
-- ============================================================
create or replace function public.claim_payment_gateway_event_for_processing(p_event_id uuid)
returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_row_count integer;
begin
  update public.payment_gateway_events
  set processing_status = 'processing'
  where id = p_event_id and processing_status in ('received', 'failed');

  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

-- ============================================================
-- mark_payment_gateway_event_processed: fecha o ciclo de processamento do
-- evento (sucesso, falha ou ignorado deliberadamente), sempre incrementando
-- attempt_count -- serve tanto para a 1a tentativa quanto para reprocesso
-- manual de um evento que falhou.
-- ============================================================
create or replace function public.mark_payment_gateway_event_processed(
  p_event_id uuid,
  p_status text,
  p_organization_id uuid default null,
  p_error text default null
)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if p_status not in ('processed','failed','ignored') then
    raise exception 'Status de processamento invalido.';
  end if;

  update public.payment_gateway_events
  set processing_status = p_status,
      processed_at = now(),
      attempt_count = attempt_count + 1,
      last_error = p_error,
      organization_id = coalesce(organization_id, p_organization_id)
  where id = p_event_id;
end;
$$;

revoke all on function public.record_payment_gateway_event(text, text, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_payment_gateway_event(text, text, text, text, jsonb, uuid) to service_role;

revoke all on function public.mark_payment_gateway_event_processed(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_payment_gateway_event_processed(uuid, text, uuid, text) to service_role;

revoke all on function public.claim_payment_gateway_event_for_processing(uuid) from public, anon, authenticated;
grant execute on function public.claim_payment_gateway_event_for_processing(uuid) to service_role;

commit;
