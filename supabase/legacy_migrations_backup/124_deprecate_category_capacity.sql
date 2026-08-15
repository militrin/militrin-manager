-- 124_deprecate_category_capacity.sql
-- O controle de vagas por categoria passou a ser feito por (lote, categoria)
-- desde a 122_batch_category_limits.sql. O campo "Capacidade" da categoria
-- (ticket_categories.capacity) esta saindo da tela de administracao de
-- categorias -- zera aqui qualquer valor legado pra ninguem mais ficar
-- limitado por um teto invisivel, sem tela pra ver ou editar.
--
-- As checagens que ja existem em get_event_ticket_categories, create_registration
-- e confirm_registration_payment (todas em 122) continuam no lugar -- sao
-- todas guardadas por "if capacity is not null", entao com a coluna zerada
-- elas nunca mais disparam. Nao ha necessidade de editar essas funcoes.

begin;

update public.ticket_categories
set capacity = null
where capacity is not null;

commit;
