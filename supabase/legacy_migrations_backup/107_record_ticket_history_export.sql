-- 107_record_ticket_history_export.sql
-- Auditoria protegida das exportacoes administrativas do historico de ingresso.
begin;

do $migration$
declare
  v_signature regprocedure:=to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)');
  v_definition text;
begin
  if exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='record_ticket_history_export'
      and p.oid<>coalesce(v_signature::oid,'0'::oid)
  ) then raise exception 'Assinatura conflitante de record_ticket_history_export encontrada.'; end if;
  if v_signature is null then return; end if;
  select lower(pg_get_functiondef(v_signature)) into v_definition;
  if position('ticket_history_exported' in v_definition)=0
     or position('auth.uid()' in v_definition)=0
     or position('user_can_access_organization' in v_definition)=0
     or position('security definer' in v_definition)=0 then
    raise exception 'Definicao ativa de record_ticket_history_export diverge do contrato 107.';
  end if;
end;
$migration$;

create or replace function public.record_ticket_history_export(
  p_ticket_id uuid,
  p_format text,
  p_scope text,
  p_from date default null,
  p_to date default null,
  p_type text default null,
  p_filter_event_id uuid default null
)
returns table(audit_id uuid,audited_at timestamptz)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_ticket public.tickets%rowtype;
  v_audit_id uuid:=gen_random_uuid();
  v_audited_at timestamptz:=now();
  v_format text:=lower(trim(coalesce(p_format,'')));
  v_scope text:=lower(trim(coalesce(p_scope,'')));
  v_type text:=nullif(trim(coalesce(p_type,'')),'');
  v_filters jsonb;
begin
  if v_actor is null then raise exception 'Sessao autenticada obrigatoria.'; end if;
  if not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('orders.view')
  ) then raise exception 'Sem permissao para exportar o historico do ingresso.'; end if;
  if v_format not in('pdf','csv') then raise exception 'Formato de exportacao invalido.'; end if;
  if v_scope not in('ticket','account') then raise exception 'Escopo de exportacao invalido.'; end if;
  if p_from is not null and p_to is not null and p_from>p_to then
    raise exception 'Periodo de exportacao invalido.';
  end if;
  if v_type is not null and (length(v_type)>100 or v_type!~'^[a-z0-9_.:-]+$') then
    raise exception 'Filtro de tipo invalido.';
  end if;
  if v_type='__technical__' and not public.current_user_has_permission('audit.view') then
    raise exception 'Sem permissao para exportar auditoria tecnica.';
  end if;

  select * into v_ticket from public.tickets t where t.id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then
    raise exception 'Ingresso invalido ou sem acesso a organizacao.';
  end if;
  if v_scope='ticket' and p_filter_event_id is not null then
    raise exception 'Filtro de evento nao se aplica ao escopo do ingresso.';
  end if;
  if p_filter_event_id is not null and not exists(
    select 1 from public.events e
    where e.id=p_filter_event_id and e.organization_id=v_ticket.organization_id
  ) then raise exception 'Evento filtrado invalido ou sem acesso a organizacao.'; end if;

  v_filters:=jsonb_strip_nulls(jsonb_build_object(
    'from',p_from,
    'to',p_to,
    'type',v_type,
    'event_id',case when v_scope='account' then p_filter_event_id end
  ));
  insert into public.audit_logs(id,action,entity_type,entity_id,event_id,details,created_at)
  values(
    v_audit_id,'ticket_history_exported','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object(
      'actor_user_id',v_actor,
      'format',v_format,
      'scope',v_scope,
      'filters',v_filters,
      'organization_id',v_ticket.organization_id
    ),
    v_audited_at
  );
  return query select v_audit_id,v_audited_at;
end;
$$;

do $migration$
declare v_definition text; v_normalized text;
begin
  select lower(pg_get_functiondef(to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)'))) into v_definition;
  v_normalized:=regexp_replace(v_definition,'\s+','','g');
  if position('ticket_history_exported' in v_definition)=0
     or position('auth.uid()' in v_definition)=0
     or position('now()' in v_definition)=0
     or position('''actor_user_id'',v_actor' in v_normalized)=0
     or position('audit_logs(id,actor,' in v_normalized)>0
     or position('service_role' in v_definition)>0 then
    raise exception 'Validacao final da funcao 107 falhou.';
  end if;
end;
$migration$;

revoke all on function public.record_ticket_history_export(uuid,text,text,date,date,text,uuid) from public,anon,authenticated;
grant execute on function public.record_ticket_history_export(uuid,text,text,date,date,text,uuid) to authenticated;

commit;
