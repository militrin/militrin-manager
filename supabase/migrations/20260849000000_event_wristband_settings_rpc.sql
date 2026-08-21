-- Fecha a ultima lacuna do fluxo de pulseiras: hoje nao existe NENHUMA RPC
-- que escreva em events.wristband_enabled/wristband_required_for_checkin/
-- wristband_required_for_kit -- confirmado por investigacao dedicada (grep
-- em todas as migrations por "wristband_enabled =" fora de leitura). O
-- componente src/app/operacoes/components/EventWristbandSettings.tsx ja
-- existia chamando uma action inexistente (updateEventWristbandSettingsAction)
-- e nunca foi montado em pagina nenhuma -- ver correcao no frontend, que
-- reescreve esse componente e o monta na Etapa 6 (Itens de kit) da edicao
-- do evento, mesmo padrao ja usado por set_event_participant_item_changes/
-- ItemChangeRules.
--
-- Regra efetiva (objetivo 3 -- wristband_enabled=false SEMPRE zera as
-- flags dependentes, nunca confia em legado/paramentro inconsistente):
-- a mesma regra ja aplicada nas RPCs de check-in/entrega da migration
-- anterior (20260848000000: `coalesce(wristband_enabled,false) and
-- coalesce(wristband_required_for_X,false)`), reforcada aqui tambem na
-- ESCRITA -- nunca grava required_for_checkin/required_for_kit=true se
-- enabled=false, mesmo que o caller (bug de frontend, etc.) envie true.
-- A tabela ja tem um CHECK constraint equivalente
-- (events_wristband_requirements_check, ver remote_schema.sql) que
-- rejeitaria a gravacao inconsistente de qualquer forma -- esta RPC so
-- evita depender exclusivamente dele (nunca expor um erro de constraint cru
-- pro operador; normaliza antes de tentar gravar).
begin;

create or replace function public.set_event_wristband_settings(
  p_event_id uuid, p_enabled boolean, p_required_for_checkin boolean default false, p_required_for_kit boolean default false
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_event public.events%rowtype;
  v_enabled boolean := coalesce(p_enabled, false);
  v_required_for_checkin boolean;
  v_required_for_kit boolean;
begin
  if v_actor is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Sem acesso a este evento.';
  end if;

  -- Regra efetiva: exigencia de pulseira so pode ser true quando o uso de
  -- pulseiras esta ativo. Nunca grava um estado inconsistente, mesmo que o
  -- chamador peca.
  v_required_for_checkin := v_enabled and coalesce(p_required_for_checkin, false);
  v_required_for_kit := v_enabled and coalesce(p_required_for_kit, false);

  if v_event.wristband_enabled = v_enabled
    and v_event.wristband_required_for_checkin = v_required_for_checkin
    and v_event.wristband_required_for_kit = v_required_for_kit then
    return true;
  end if;

  update public.events
  set wristband_enabled = v_enabled,
      wristband_required_for_checkin = v_required_for_checkin,
      wristband_required_for_kit = v_required_for_kit,
      updated_at = now()
  where id = p_event_id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'event_wristband_settings_updated', 'events', p_event_id, p_event_id,
    jsonb_build_object(
      'actor_user_id', v_actor,
      'organization_id', v_event.organization_id,
      'previous', jsonb_build_object(
        'wristband_enabled', v_event.wristband_enabled,
        'wristband_required_for_checkin', v_event.wristband_required_for_checkin,
        'wristband_required_for_kit', v_event.wristband_required_for_kit
      ),
      'new', jsonb_build_object(
        'wristband_enabled', v_enabled,
        'wristband_required_for_checkin', v_required_for_checkin,
        'wristband_required_for_kit', v_required_for_kit
      )
    )
  );

  return true;
end; $$;

revoke all on function public.set_event_wristband_settings(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_event_wristband_settings(uuid, boolean, boolean, boolean) to authenticated, service_role;

commit;
