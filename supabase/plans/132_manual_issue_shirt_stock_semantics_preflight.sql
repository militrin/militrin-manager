-- 132_manual_issue_shirt_stock_semantics_preflight.sql
-- Somente leitura. Mostra, por evento, se ha item ativo de camiseta e se o
-- estoque fisico e obrigatorio -- para conferir que a nova checagem das
-- RPCs de emissao manual vai se comportar como o checkout publico.

select e.id, e.name, e.limit_shirt_selection_to_stock,
  exists(
    select 1 from public.event_kit_items eki
    where eki.event_id = e.id and eki.item_type = 'shirt' and eki.is_active = true
  ) as tem_item_camiseta_ativo
from public.events e
where e.is_active = true
order by e.name;
-- eventos com tem_item_camiseta_ativo = false: emissao manual passa a
-- ignorar camiseta (nao pede nem grava tipo/tamanho), igual ao checkout.
-- eventos com limit_shirt_selection_to_stock = false: emissao manual passa
-- a aceitar qualquer tamanho configurado sem checar/reservar saldo.
