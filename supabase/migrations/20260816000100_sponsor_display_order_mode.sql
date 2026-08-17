-- Estrategia de exibicao do carrossel de patrocinadores: 'random' (ordem
-- embaralhada, estavel durante a sessao/carregamento da Home -- nunca
-- reembaralhada a cada troca automatica de banner, porque o RPC so e
-- chamado uma vez por carregamento da pagina e o carrossel client-side so
-- navega por indice dentro do array ja recebido) ou 'manual' (sort_order
-- ASC, controlado pelo admin). Pertence a organizations, mesmo nivel de
-- sponsor_carousel_interval_seconds (20260815006600_sponsors_module.sql).
begin;

alter table public.organizations
  add column if not exists sponsor_carousel_order_mode text not null default 'random'
    check (sponsor_carousel_order_mode in ('random', 'manual'));

comment on column public.organizations.sponsor_carousel_order_mode is
  'Estrategia de ordenacao do carrossel de patrocinadores na Home: random (embaralhado por sessao/carregamento) ou manual (sort_order ASC, definido pelo admin).';

create or replace function public.admin_set_sponsor_carousel_order_mode(p_organization_id uuid, p_order_mode text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_mode text := lower(trim(coalesce(p_order_mode, '')));
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  v_org := coalesce(p_organization_id, public.current_organization_id());
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if v_mode not in ('random', 'manual') then
    raise exception 'Estrategia de exibicao invalida. Use "random" ou "manual".';
  end if;

  -- Troca de estrategia nunca altera sort_order existente -- so muda como
  -- ele e (ou nao e) usado na leitura da Home, para poder ser reaproveitado
  -- se o admin voltar para "manual" depois.
  update public.organizations set sponsor_carousel_order_mode = v_mode where id = v_org;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_carousel_order_mode_updated', 'organizations', v_org, null, jsonb_build_object('actor_user_id', v_actor, 'order_mode', v_mode));
end; $$;

revoke all on function public.admin_set_sponsor_carousel_order_mode(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_carousel_order_mode(uuid, text) to authenticated;

-- Move um patrocinador ativo uma posicao para cima/baixo, trocando
-- sort_order com o vizinho ativo mais proximo -- nunca aceita um numero
-- livre do client, entao nunca produz sort_order duplicado/inconsistente.
-- So considera vizinhos ativos: patrocinadores inativos nao participam da
-- sequencia exibida e ficam fora da troca.
create or replace function public.admin_move_sponsor(p_sponsor_id uuid, p_direction text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_sponsor public.sponsors%rowtype; v_neighbor public.sponsors%rowtype; v_direction text := lower(trim(coalesce(p_direction, '')));
begin
  if v_actor is null or not public.current_user_has_permission('sponsors.manage') then
    raise exception 'Sem permissao para gerenciar patrocinadores.';
  end if;
  if v_direction not in ('up', 'down') then raise exception 'Direcao invalida. Use "up" ou "down".'; end if;

  select * into v_sponsor from public.sponsors where id = p_sponsor_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_sponsor.organization_id) then
    raise exception 'Patrocinador nao encontrado.';
  end if;
  if not v_sponsor.is_active then raise exception 'Apenas patrocinadores ativos participam da sequencia exibida.'; end if;

  if v_direction = 'up' then
    select * into v_neighbor from public.sponsors
    where organization_id = v_sponsor.organization_id and is_active = true and id <> v_sponsor.id
      and (sort_order, name) < (v_sponsor.sort_order, v_sponsor.name)
    order by sort_order desc, name desc limit 1 for update;
  else
    select * into v_neighbor from public.sponsors
    where organization_id = v_sponsor.organization_id and is_active = true and id <> v_sponsor.id
      and (sort_order, name) > (v_sponsor.sort_order, v_sponsor.name)
    order by sort_order asc, name asc limit 1 for update;
  end if;

  if not found then return; end if;

  update public.sponsors set sort_order = v_neighbor.sort_order, updated_at = now() where id = v_sponsor.id;
  update public.sponsors set sort_order = v_sponsor.sort_order, updated_at = now() where id = v_neighbor.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details) values
    ('sponsor_reordered', 'sponsors', v_sponsor.id, null, jsonb_build_object('actor_user_id', v_actor,
      'organization_id', v_sponsor.organization_id, 'direction', v_direction, 'swapped_with', v_neighbor.id));
end; $$;

revoke all on function public.admin_move_sponsor(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_move_sponsor(uuid, text) to authenticated;

-- get_active_sponsors_for_home passa a respeitar o modo da organizacao:
-- manual = sort_order ASC (como sempre foi); random = embaralhado nesta
-- leitura (uma leitura por carregamento da Home -- estabilidade durante a
-- sessao vem do client nunca re-chamar isto entre trocas automaticas de
-- banner). Retorno da funcao nao muda, so o ORDER BY -- create or replace
-- basta, sem precisar dropar.
create or replace function public.get_active_sponsors_for_home()
returns table(sponsor_id uuid, name text, banner_url text, link_url text, sort_order integer, carousel_interval_seconds integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, s.banner_url, s.link_url, s.sort_order, o.sponsor_carousel_interval_seconds
  from public.sponsors s
  join public.organizations o on o.id = s.organization_id
  where s.is_active = true and s.banner_url is not null
  order by
    case when o.sponsor_carousel_order_mode = 'manual' then 0 else 1 end,
    case when o.sponsor_carousel_order_mode = 'manual' then s.sort_order end,
    case when o.sponsor_carousel_order_mode = 'manual' then s.name end,
    case when o.sponsor_carousel_order_mode <> 'manual' then random() end;
$$;

revoke all on function public.get_active_sponsors_for_home() from public, anon;
grant execute on function public.get_active_sponsors_for_home() to authenticated;

commit;
