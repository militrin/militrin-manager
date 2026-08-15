-- 115_platform_brand_theme.sql
-- Configuracao global de cor de marca (tema visual) do sistema. Linha singleton
-- em platform_settings, leitura publica (necessaria para renderizar o tema antes
-- do login), escrita restrita a quem tem a permissao settings.manage via RPC.

begin;

create table if not exists public.platform_settings (
  id boolean primary key default true,
  brand_theme text not null default 'pink',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint platform_settings_singleton check (id),
  constraint platform_settings_brand_theme_check check (
    brand_theme in ('pink', 'green', 'blue', 'purple', 'amber', 'teal')
  )
);

insert into public.platform_settings (id, brand_theme)
values (true, 'pink')
on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

drop policy if exists "platform_settings_select_all" on public.platform_settings;
create policy "platform_settings_select_all"
on public.platform_settings for select
to authenticated, anon
using (true);

create or replace function public.set_platform_brand_theme(p_theme text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.current_user_has_permission('settings.manage') then
    raise exception 'Sem permissao para alterar configuracoes da plataforma.';
  end if;
  if p_theme not in ('pink', 'green', 'blue', 'purple', 'amber', 'teal') then
    raise exception 'Tema invalido: %', p_theme;
  end if;

  update public.platform_settings
  set brand_theme = p_theme, updated_at = now(), updated_by = auth.uid()
  where id = true;
end;
$$;

grant execute on function public.set_platform_brand_theme(text) to authenticated;

commit;
