begin;

-- Release Gate #1 Parte 2: lease de processamento de webhook.
-- Separado da 45 de proposito: a 45 e PIX/origem/emissao administrativa;
-- esta migration so trata evento stuck em `processing` apos crash entre
-- claim e mark_*. Nao altera regras de emissao nem de PIX.

alter table public.payment_gateway_events
  add column if not exists processing_started_at timestamptz;

comment on column public.payment_gateway_events.processing_started_at is
  'Inicio do lease de processamento. Evento `processing` com lease mais antigo que 3 minutos pode ser reclaimado. Evento processado/ignored nunca volta.';

create index if not exists idx_payment_gateway_events_processing_lease
  on public.payment_gateway_events (processing_started_at)
  where processing_status = 'processing';

-- received/failed -> processing (primeira vez ou retry apos failed).
-- processing abandonado (lease > 3 min, ou processing legado sem lease e
-- received_at > 3 min) tambem e reclaimavel. processed/ignored nunca.
create or replace function public.claim_payment_gateway_event_for_processing(p_event_id uuid)
returns boolean
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row_count integer;
begin
  update public.payment_gateway_events
  set processing_status = 'processing',
      processing_started_at = now()
  where id = p_event_id
    and (
      processing_status in ('received', 'failed')
      or (
        processing_status = 'processing'
        and (
          (
            processing_started_at is not null
            and processing_started_at < now() - interval '3 minutes'
          )
          or (
            processing_started_at is null
            and received_at < now() - interval '3 minutes'
          )
        )
      )
    );

  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

revoke all on function public.claim_payment_gateway_event_for_processing(uuid) from public, anon, authenticated;
grant execute on function public.claim_payment_gateway_event_for_processing(uuid) to service_role;

commit;
