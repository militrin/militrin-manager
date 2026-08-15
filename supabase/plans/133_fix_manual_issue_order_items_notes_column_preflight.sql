-- 133_fix_manual_issue_order_items_notes_column_preflight.sql
-- Somente leitura. Confirma que order_items realmente nao tem coluna
-- "notes" (causa do erro "column notes of relation order_items does not
-- exist" ao emitir ingresso manualmente) e que participants tem.

select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('order_items','participants')
  and column_name = 'notes';
-- esperado: so uma linha, table_name = 'participants'.
