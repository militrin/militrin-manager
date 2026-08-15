-- 080_fix_import_inference_audit_rpc.sql
-- Recria a RPC de auditoria da inferencia de campos sem alterar o historico aplicado.

begin;

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
  if v_actor is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select ib.event_id
  into v_event_id
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

  select lower(au.email)
  into v_actor_email
  from auth.users au
  where au.id = v_actor;

  begin
    insert into public.audit_logs (
      action,
      entity_type,
      entity_id,
      event_id,
      details
    ) values (
      'import_field_inferred',
      'participants',
      p_participant_id,
      v_event_id,
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
      p_import_batch_id,
      p_participant_id,
      sqlstate,
      sqlerrm;
    return false;
  end;
end;
$$;

revoke all on function public.record_import_field_inference_audit(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.record_import_field_inference_audit(uuid, uuid, text, text, text, text)
  to authenticated;

commit;
