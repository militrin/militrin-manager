# Rollback da regularização de titularidade do Douglas

Não executar automaticamente. O rollback só é seguro se, depois da regularização, os dois ingressos continuarem sem titular e não houver histórico posterior de nomeação ou transferência.

Antes de restaurar, confirmar para cada ticket:

- evento `6c931940-03ad-48c2-836c-754924a00d00`;
- `tickets.participant_id`, `order_items.participant_id` e `order_items.registration_contact_id` ainda nulos;
- último histórico de titularidade tem motivo `regularization_duplicate_autoassigned_holder`;
- nenhum histórico posterior existe;
- Douglas ainda é o contato `91b9bc32-67d7-4ffb-8354-598b842bf559` e participante `b2b4b9f2-1cab-452a-b76d-5380e631e348` no evento;
- restaurar não violará a unicidade. Normalmente ela violará enquanto o ticket preservado continuar ativo; por isso o rollback exige primeiro uma decisão operacional explícita sobre qual ingresso ficará com Douglas.

Se aprovado, numa única transação e sob locks dos tickets/order_items:

1. definir qual ticket será o único titularizado por Douglas;
2. usar `admin_set_ticket_holder_contact(ticket_id, contact_id, motivo)` para esse único ticket;
3. não restaurar os dois excedentes simultaneamente;
4. confirmar que pedidos, pagamentos, categorias, lotes, camisetas, tokens e itens permaneceram inalterados;
5. registrar motivo e operador reais no histórico.

Não apagar os registros `holder_removed`: eles documentam a regularização e devem ser preservados.
