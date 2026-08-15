-- 124_deprecate_category_capacity_preflight.sql
-- Somente leitura. Mede o impacto de zerar ticket_categories.capacity antes
-- de aplicar a 124 (o campo "Capacidade" esta saindo da tela de categorias,
-- ja que o controle de vagas real agora e por lote+categoria desde a 122).

select count(*) as categories_with_capacity_set
from public.ticket_categories
where capacity is not null;

select id, event_id, name, capacity
from public.ticket_categories
where capacity is not null
order by event_id, name;
-- lista as categorias que hoje dependem desse teto extra -- confirme que
-- nenhuma delas precisa continuar limitada por aqui (o limite por lote deve
-- cobrir o caso de uso real).
