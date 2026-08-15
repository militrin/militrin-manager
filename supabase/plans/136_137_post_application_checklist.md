# Checklist pós-aplicação das migrations 136 e 137

Execute primeiro `136_137_post_application_validation.sql`. Todos os blocos marcados
como “esperado: zero linhas” devem estar vazios antes dos testes funcionais.

## Estoque e entrega

- Configure uma variante com estoque total 1 e sem entregas.
- Em duas sessões, tente entregar simultaneamente essa variante para tickets distintos.
  Apenas uma chamada deve finalizar; a outra deve retornar `SHIRT_OUT_OF_STOCK`.
- Repita a entrega do ticket vencedor. A RPC deve ser idempotente e não criar novo
  movimento nem incrementar `delivered_quantity` novamente.
- Em uma transação de teste, provoque falha no check-in após a entrega do kit e confirme
  que estoque, movimentos, `participant_kit_items.status` e `delivered_at` permanecem
  inalterados após o rollback.
- Tente trocar uma camiseta para variante sem disponibilidade física. A troca deve ser
  recusada e tipo/tamanho/reservas devem permanecer inalterados.

## Titularidade

- Atribua um ticket a contato com conta e confira ticket, order item, participante e
  histórico.
- Transfira Douglas para Bruna existente somente em `registration_contacts`, com
  `user_id` nulo. A operação deve concluir, registrar o contato de Bruna e manter
  `new_user_id` nulo.
- Transfira contato sem conta para outro contato sem conta.
- Remova o titular e confirme `registration_contact_id` nulo e histórico com novo
  titular vazio.
- Em todos os casos, confirme que comprador, pedido e pagamento não mudaram.
- Confirme que contato com ticket ativo no mesmo evento é recusado, contato com ticket
  em outro evento é aceito e ticket cancelado no mesmo evento não bloqueia.
- Em duas sessões, atribua simultaneamente tickets diferentes ao mesmo contato/evento.
  Somente uma operação deve concluir.

## Materialização de camiseta

- Abra ou entregue um dos tickets apontados pelo preflight como vínculo legado sem
  `variant_id`; confirme que o vínculo existente foi enriquecido sem alterar status,
  quantidade ou timestamps de entrega.
- Execute novamente `ensure_ticket_kit_items`; não deve haver duplicata nem mudança de
  contadores de estoque.

## Regularização Douglas

- Somente após validar o preflight e definir o operador, execute separadamente o plano
  `137_douglas_duplicate_holder_regularization.sql`.
- Reexecute `136_137_post_application_validation.sql` e confirme um único ticket ativo
  de Douglas no Militrin 2026, preservação integral do comprador e dois eventos de
  histórico/auditoria com motivo `regularization_duplicate_autoassigned_holder`.
