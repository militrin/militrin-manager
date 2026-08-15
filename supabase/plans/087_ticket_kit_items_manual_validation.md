# Validação manual — itens operacionais por ticket

Não execute este roteiro em produção antes de revisar e aplicar a migration 087.

1. Ticket sem titular: crie/confirme um `order_item` sem `participant_id`, materialize pelo `ticket_id` e confirme que os itens simples e a camiseta com variante do `order_item` são criados; titular continua nulo.
2. Atribuição posterior: registre IDs, status, `delivered_at` e `variant_data`; atribua titular e confirme que apenas o `participant_id` auxiliar mudou.
3. Troca de titular: repita a conferência e valide ausência de novos `inventory_movements`.
4. Mesmo participante em dois tickets: materialize ambos; entregue somente um e confira estados independentes por `(ticket_id, kit_item_id)`.
5. Pedido com seis ingressos: confirme seis conjuntos, cada um com todos os `event_kit_items` ativos aplicáveis.
6. Idempotência: execute `materialize_ticket_kit_items` duas vezes e confirme `created_count = 0` na segunda chamada.
7. Legado ambíguo: confira o `SELECT` diagnóstico e os logs `ticket_kit_legacy_unresolved`; `ticket_id` deve permanecer nulo.
8. Camiseta incompleta: remova modelo/tamanho do `order_item`; itens simples devem ser criados e a camiseta deve aparecer em `skipped`.
9. Entrega e check-in: execute `deliver_items_and_checkin(ticket_id)`; force uma falha de check-in e confirme rollback integral da entrega.
10. Estoque: entregue, desfaça e troque camiseta em um ticket; confira que nenhum outro ticket foi alterado.
11. Reserva pré-ticket: crie inscrição pendente e confirme que o vínculo usa `order_item_id`, nunca somente `participant_id`; após emissão, o mesmo ID deve receber `ticket_id`.
12. Unicidade antiga: atribua o mesmo participante a dois tickets e confirme que ambos aceitam o mesmo `kit_item_id` sem colisão.
13. Item inativo: desative um item já vinculado e adicione outro ativo; a Central não pode usar o item inativo para considerar o kit entregue.
14. Segurança: confirme que `anon` não executa RPCs legadas nem `get_ticket_kit_items`; usuário autenticado de outra organização também deve ser bloqueado.
15. Concorrência: execute duas materializações simultâneas do mesmo ticket e confirme um único vínculo por item.
16. Camiseta: faça a troca pela Central, Minha Conta e ficha administrativa; todas devem produzir auditoria `ticket_shirt_changed` e movimentar somente o estoque daquele ticket.
17. APIs antigas: confirme que chamadas por `participant_id` retornam `permission denied for function`.
18. Preflight real: confirme `unresolved_legacy_allowed = 8`, `imported_repairable = 8`, `unresolved_blocking = 0` e `SAFE_TO_APPLY = true` antes da aplicacao.
19. Cadeia importada: para cada participante reparado, confirme exatamente um pedido `imported_holder`, um `order_item` e um ticket, todos no mesmo evento e sem `orders.user_id`.
20. Preservacao: compare os IDs, status, quantidades, variantes e datas dos 16 `participant_kit_items`; os oito importados devem apenas ganhar as chaves operacionais e os oito legados devem conservar `ticket_id`/`order_item_id` nulos com `legacy_unresolved = true`.
21. Estoque e pagamento: compare `shirt_inventory`, `inventory_movements` e os campos financeiros de `payments` antes/depois; a regularizacao nao pode produzir alteracao.
22. Idempotencia: repita as consultas de criacao dentro de uma transacao descartavel e confirme que `orders`, `order_items`, `tickets` e logs de reparo nao duplicam.
