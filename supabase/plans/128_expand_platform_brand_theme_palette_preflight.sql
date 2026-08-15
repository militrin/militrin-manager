-- 128_expand_platform_brand_theme_palette_preflight.sql
-- Somente leitura. Confirma o estado atual do CHECK e da RPC antes de
-- ampliar a lista de temas aceitos.

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.platform_settings'::regclass
  and conname = 'platform_settings_brand_theme_check';
-- esperado: CHECK (brand_theme = ANY (ARRAY['pink','green','blue','purple','amber','teal']))

select brand_theme from public.platform_settings where id = true;
-- esperado: o tema atualmente selecionado -- deve continuar sendo um dos 6
-- originais, entao a troca do CHECK nao pode invalidar a linha existente.
