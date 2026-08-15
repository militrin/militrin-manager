-- 101_filter_confirmed_history_in_import_finalization.sql
-- Exclui histories duplicate da evidencia de lote sem reescrever o restante
-- da funcao ativa, inclusive a autorizacao do titular introduzida pela 096.

begin;

do $migration$
declare
  v_signature regprocedure:=to_regprocedure(
    'public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)'
  );
  v_definition text;
  v_normalized text;
  v_expected text:=$expected$where ph.participant_id=p_participant_id and ph.source='import';$expected$;
  v_replacement text:=$replacement$where ph.participant_id=p_participant_id and ph.source='import' and ph.status='confirmed';$replacement$;
begin
  if v_signature is null then
    raise exception 'Funcao finalize_imported_participant_after_issue_resolution nao encontrada.';
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  v_normalized:=regexp_replace(lower(v_definition),'\s+','','g');

  -- Nao permite aplicar a correcao sobre a versao anterior a autorizacao do
  -- titular da 096 ou sobre outro corpo desconhecido.
  if position(
    'ifv_actorisdistinctfromv_participant.user_idandnotpublic.user_can_access_organization'
    in v_normalized
  )=0 then
    raise exception 'Definicao ativa sem a autorizacao do titular esperada da migration 096.';
  end if;

  -- Reaplicacao segura: a unica mudanca pretendida ja esta presente.
  if position(
    'whereph.participant_id=p_participant_idandph.source=''import''andph.status=''confirmed'';'
    in v_normalized
  )>0 then
    return;
  end if;

  if position(v_expected in v_definition)=0 then
    raise exception 'Predicado de evidencia de lote inesperado; migration 101 nao aplicada.';
  end if;

  v_definition:=replace(v_definition,v_expected,v_replacement);
  execute v_definition;

  select regexp_replace(lower(pg_get_functiondef(v_signature)),'\s+','','g')
  into v_normalized;
  if position(
    'whereph.participant_id=p_participant_idandph.source=''import''andph.status=''confirmed'';'
    in v_normalized
  )=0 then
    raise exception 'Filtro confirmed nao foi preservado na funcao final.';
  end if;
end;
$migration$;

revoke all on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)
  from public,anon,authenticated;
grant execute on function public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)
  to authenticated;

commit;
