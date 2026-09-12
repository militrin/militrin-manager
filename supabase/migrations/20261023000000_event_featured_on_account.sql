-- Evento em destaque na Minha Conta + fuso canônico.
--
-- Cabeçalho da Minha Conta deixa de pegar o "próximo evento com inscrição
-- aberta" (parecia preso a um evento fixo) e passa a usar um flag explícito
-- por organização: no máximo 1 evento destacado.
--
-- timezone documenta a parede canônica (America/Sao_Paulo). Não migra
-- starts_at/ends_at existentes: eventos reais podem ter sido compensados
-- manualmente; a correção de gravação/exibição fica na aplicação.

begin;

alter table public.events
  add column if not exists timezone text not null default 'America/Sao_Paulo';

alter table public.events
  add column if not exists featured_on_account boolean not null default false;

alter table public.events drop constraint if exists events_timezone_not_blank;
alter table public.events add constraint events_timezone_not_blank
  check (length(btrim(timezone)) > 0);

comment on column public.events.timezone is
  'IANA TZ da parede do evento. Default America/Sao_Paulo. Datetime-local do admin é gravado neste fuso; telas e ingresso exibem neste fuso. Nunca compensar com offset fixo +3/-3.';

comment on column public.events.featured_on_account is
  'Se true, este evento é o destaque do cabeçalho da Minha Conta. No máximo um por organização. O cabeçalho só renderiza se o evento continuar ativo/elegível.';

create unique index if not exists events_one_featured_on_account_per_org
  on public.events (organization_id)
  where featured_on_account;

create or replace function public.set_event_featured_on_account(
  p_event_id uuid,
  p_featured boolean
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if coalesce(p_featured, false) then
    update public.events
       set featured_on_account = false
     where organization_id = v_org
       and featured_on_account
       and id <> p_event_id;

    update public.events
       set featured_on_account = true
     where id = p_event_id;
  else
    update public.events
       set featured_on_account = false
     where id = p_event_id;
  end if;
end;
$$;

revoke all on function public.set_event_featured_on_account(uuid, boolean) from public, anon;
grant execute on function public.set_event_featured_on_account(uuid, boolean) to authenticated, service_role;

commit;
