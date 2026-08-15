-- 079_participant_data_issues.sql
-- Permite importar participantes incompletos e registra bloqueios contextuais.

begin;

alter table public.participants
  alter column cpf drop not null,
  alter column birth_date drop not null,
  alter column shirt_type drop not null,
  alter column shirt_size drop not null;

alter table public.import_batch_rows
  drop constraint if exists import_batch_rows_status_check;

alter table public.import_batch_rows
  add constraint import_batch_rows_status_check check (
    status in ('ready', 'data_pending', 'review_required', 'duplicate', 'error', 'skipped', 'imported')
  ),
  add column if not exists data_issues jsonb not null default '[]'::jsonb;

create table if not exists public.participant_data_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  field_code text not null,
  issue_type text not null,
  message text not null,
  blocks_payment boolean not null default false,
  blocks_ticket_issuance boolean not null default false,
  blocks_checkin boolean not null default false,
  blocks_kit_delivery boolean not null default false,
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint participant_data_issues_active_unique
    unique nulls not distinct (participant_id, import_batch_id, field_code, issue_type, status)
);

create index if not exists idx_participant_data_issues_open
  on public.participant_data_issues(event_id, participant_id, field_code)
  where status = 'open';

alter table public.participant_data_issues enable row level security;

create policy participant_data_issues_admin_select
on public.participant_data_issues for select to authenticated
using (
  public.is_platform_owner(auth.uid())
  or (
    public.user_can_access_organization(auth.uid(), organization_id)
    and (
      public.is_active_owner(auth.uid())
      or public.resolve_user_permission(auth.uid(), 'participants.view')
    )
  )
);

create policy participant_data_issues_holder_select
on public.participant_data_issues for select to authenticated
using (
  exists (
    select 1 from public.participants p
    where p.id = participant_data_issues.participant_id
      and p.user_id = auth.uid()
  )
);

grant select on public.participant_data_issues to authenticated;

create or replace function public.reevaluate_participant_data_issues(
  p_participant_id uuid,
  p_import_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_batch public.registration_batches%rowtype;
  v_price public.registration_batch_prices%rowtype;
  v_gender text;
  v_base numeric;
  v_open integer;
begin
  select * into v_participant from public.participants where id = p_participant_id for update;
  if not found then raise exception 'Participante nao encontrado.'; end if;

  select * into v_event from public.events where id = v_participant.event_id;
  if not found then raise exception 'Evento nao encontrado.'; end if;

  if v_actor is not null
    and v_actor is distinct from v_participant.user_id
    and not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Usuario sem acesso ao participante.';
  end if;

  select * into v_batch from public.registration_batches
  where id = v_participant.batch_id;

  if not found then
    select * into v_batch from public.registration_batches
    where event_id = v_participant.event_id and is_active = true
    order by sequence_number asc limit 1;
  end if;

  if v_batch.id is not null and v_participant.ticket_category_id is not null then
    select * into v_price from public.registration_batch_prices
    where batch_id = v_batch.id
      and ticket_category_id = v_participant.ticket_category_id;
  end if;

  v_gender := lower(trim(coalesce(v_participant.gender, '')));

  if v_price.id is not null
    and v_price.male_price is distinct from v_price.female_price
    and v_gender not in ('masculino', 'male', 'm', 'feminino', 'female', 'f') then
    insert into public.participant_data_issues (
      organization_id, event_id, participant_id, import_batch_id, field_code,
      issue_type, message, blocks_payment, blocks_ticket_issuance
    ) values (
      v_event.organization_id, v_event.id, v_participant.id, p_import_batch_id, 'gender',
      'missing_required_for_pricing',
      'Informe o genero para calcular o valor da inscricao.', true, true
    ) on conflict do nothing;
  else
    update public.participant_data_issues
    set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where participant_id = v_participant.id
      and field_code = 'gender'
      and issue_type = 'missing_required_for_pricing'
      and status = 'open';

    if v_price.id is not null then
      v_base := case
        when v_gender in ('feminino', 'female', 'f') then v_price.female_price
        when v_gender in ('masculino', 'male', 'm') then v_price.male_price
        when v_price.male_price = v_price.female_price then v_price.male_price
        else null
      end;

      if v_base is not null then
        update public.participants
        set batch_id = v_batch.id,
            base_amount = round(v_base, 2),
            discount_amount = 0,
            final_amount = round(v_base, 2),
            amount = round(v_base, 2),
            updated_at = now()
        where id = v_participant.id;

        update public.payments
        set amount = round(v_base, 2), discount_amount = 0, final_amount = round(v_base, 2), updated_at = now()
        where participant_id = v_participant.id and payment_status <> 'paid';

        if not exists (select 1 from public.payments where participant_id = v_participant.id) then
          insert into public.payments (
            participant_id, event_id, amount, discount_amount, final_amount,
            payment_method, payment_status
          ) values (
            v_participant.id, v_event.id, round(v_base, 2), 0, round(v_base, 2),
            'pix', 'pending'
          );
        end if;
      end if;
    end if;
  end if;

  if coalesce(v_event.limit_shirt_selection_to_stock, false)
    and exists (select 1 from public.event_kit_items where event_id = v_event.id and item_type = 'shirt' and is_active = true)
    and (nullif(trim(v_participant.shirt_type), '') is null or nullif(trim(v_participant.shirt_size), '') is null) then
    insert into public.participant_data_issues (
      organization_id, event_id, participant_id, import_batch_id, field_code,
      issue_type, message, blocks_kit_delivery
    ) values (
      v_event.organization_id, v_event.id, v_participant.id, p_import_batch_id, 'shirt_selection',
      'missing_required_for_inventory',
      'Modelo e tamanho da camiseta devem ser informados antes da conclusao.', true
    ) on conflict do nothing;
  else
    update public.participant_data_issues
    set status = 'resolved', resolved_at = now(), resolved_by = v_actor, updated_at = now()
    where participant_id = v_participant.id
      and field_code = 'shirt_selection'
      and issue_type = 'missing_required_for_inventory'
      and status = 'open';
  end if;

  select count(*) into v_open
  from public.participant_data_issues
  where participant_id = v_participant.id and status = 'open';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('participant_data_issues_reevaluated', 'participants', v_participant.id, v_event.id,
    jsonb_build_object('actor_user_id', v_actor, 'import_batch_id', p_import_batch_id,
      'open_issue_count', v_open, 'source', case when p_import_batch_id is null then 'edit' else 'import' end));

  return jsonb_build_object('participant_id', v_participant.id, 'open_issue_count', v_open,
    'price_defined', v_base is not null);
end;
$$;

revoke all on function public.reevaluate_participant_data_issues(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reevaluate_participant_data_issues(uuid, uuid) to authenticated;

create or replace function public.create_pending_imported_participant(
  p_import_batch_id uuid,
  p_full_name text,
  p_cpf text default null,
  p_birth_date date default null,
  p_gender text default null,
  p_phone text default null,
  p_email text default null,
  p_city text default null,
  p_shirt_type text default null,
  p_shirt_size text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_batch public.import_batches%rowtype;
  v_event public.events%rowtype;
  v_registration_batch_id uuid;
  v_category_id uuid;
  v_participant_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if nullif(trim(p_full_name), '') is null then raise exception 'Nome obrigatorio ausente.'; end if;

  select * into v_batch from public.import_batches where id = p_import_batch_id for update;
  if not found or v_batch.import_type <> 'current_event_registrations' or v_batch.imported_by <> v_actor then
    raise exception 'Lote de importacao invalido.';
  end if;

  select * into v_event from public.events where id = v_batch.event_id;
  if not found or not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  select id into v_registration_batch_id from public.registration_batches
  where event_id = v_event.id and is_active = true order by sequence_number asc limit 1;
  select id into v_category_id from public.ticket_categories
  where event_id = v_event.id and is_active = true order by sort_order asc, name asc limit 1;

  insert into public.participants (
    event_id, full_name, cpf, birth_date, gender, phone, email, city,
    shirt_type, shirt_size, registration_status, reservation_status,
    batch_id, ticket_category_id, notes
  ) values (
    v_event.id, trim(p_full_name), nullif(trim(p_cpf), ''), p_birth_date,
    nullif(trim(p_gender), ''), nullif(trim(p_phone), ''), lower(nullif(trim(p_email), '')),
    nullif(trim(p_city), ''), nullif(trim(p_shirt_type), ''), nullif(trim(p_shirt_size), ''),
    'pending', 'pending', v_registration_batch_id, v_category_id, 'Importacao administrativa com dados pendentes'
  ) returning id into v_participant_id;

  perform public.reevaluate_participant_data_issues(v_participant_id, p_import_batch_id);
  return v_participant_id;
end;
$$;

revoke all on function public.create_pending_imported_participant(uuid, text, text, date, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_pending_imported_participant(uuid, text, text, date, text, text, text, text, text, text)
  to authenticated;

create or replace function public.record_import_field_inference_audit(
  p_import_batch_id uuid,
  p_participant_id uuid,
  p_inferred_field text,
  p_inferred_value text,
  p_inference_source text,
  p_original_value text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_event_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;

  select ib.event_id into v_event_id
  from public.import_batches ib
  join public.participants p
    on p.id = p_participant_id
   and p.event_id = ib.event_id
  where ib.id = p_import_batch_id
    and ib.imported_by = v_actor
    and ib.import_type = 'current_event_registrations';

  if v_event_id is null then
    raise exception 'Lote ou participante invalido para auditoria de inferencia.';
  end if;

  select lower(email) into v_actor_email from auth.users where id = v_actor;

  begin
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'import_field_inferred', 'participants', p_participant_id, v_event_id,
      jsonb_build_object(
        'import_batch_id', p_import_batch_id,
        'imported_by_user_id', v_actor,
        'imported_by_email', v_actor_email,
        'participant_id', p_participant_id,
        'inferred_field', p_inferred_field,
        'inferred_value', p_inferred_value,
        'inference_source', p_inference_source,
        'original_value', p_original_value
      )
    );
    return true;
  exception when others then
    raise warning 'Falha ao registrar auditoria import_field_inferred (batch %, participant %): [%] %',
      p_import_batch_id, p_participant_id, sqlstate, sqlerrm;
    return false;
  end;
end;
$$;

revoke all on function public.record_import_field_inference_audit(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_import_field_inference_audit(uuid, uuid, text, text, text, text)
  to authenticated;

commit;
