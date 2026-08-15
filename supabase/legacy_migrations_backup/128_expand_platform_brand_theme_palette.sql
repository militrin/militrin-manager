-- 128_expand_platform_brand_theme_palette.sql
-- Amplia a paleta de cor de marca de 6 para 17 opcoes (nomes de cor padrao
-- do Tailwind, mesmos tons 100-600 ja usados pelas 6 originais -- so
-- adiciona linhas novas em globals.css, nao muda o formato). Atualiza o
-- CHECK da tabela e a whitelist da RPC set_platform_brand_theme (115) pra
-- aceitar os 11 novos ids: red, rose, fuchsia, violet, indigo, sky, cyan,
-- emerald, lime, yellow, orange.

begin;

alter table public.platform_settings drop constraint if exists platform_settings_brand_theme_check;
alter table public.platform_settings add constraint platform_settings_brand_theme_check check (
  brand_theme in (
    'pink', 'red', 'rose', 'fuchsia', 'purple', 'violet', 'indigo',
    'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime',
    'yellow', 'amber', 'orange'
  )
);

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
  if p_theme not in (
    'pink', 'red', 'rose', 'fuchsia', 'purple', 'violet', 'indigo',
    'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime',
    'yellow', 'amber', 'orange'
  ) then
    raise exception 'Tema invalido: %', p_theme;
  end if;

  update public.platform_settings
  set brand_theme = p_theme, updated_at = now(), updated_by = auth.uid()
  where id = true;
end;
$$;

grant execute on function public.set_platform_brand_theme(text) to authenticated;

commit;
