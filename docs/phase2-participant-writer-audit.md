# Fase 2 — auditoria de escritores de `participants`

Data: 2026-08-14. Escopo: primeiro acesso, Minha Conta, edição de inscrição,
pendências, importação e RPCs ainda chamadas pela aplicação. Painel e relatórios
ficam fora desta fase.

## REMOVIDA

| Fluxo | Escrita removida/substituída | Fonte canônica atual |
| --- | --- | --- |
| Importação atual | upsert de dados pessoais, categoria, lote, camiseta, pagamento e status em `participants` | `registration_contacts`, `order_items`, `payments`/`orders` e `tickets` |
| Pendências | `resolve_participant_data_issues(participant_id, ...)` | `resolve_ticket_data_issues(order_item_id, ...)` |
| Finalização importada | seleção implícita por participante | `finalize_imported_ticket_after_issue_resolution(order_item_id, ...)` |
| Primeiro acesso | correção pessoal e gênero em `participants` | `registration_contacts` via `update_registration_contact_from_participant` |
| Minha Conta | sincronização pessoal/camiseta em `participants` | dados pessoais em `registration_contacts`; camiseta em `order_items`/`participant_kit_items` |
| Edição `/inscricoes/[id]/editar` | dados pessoais, camiseta, pagamento e status no participante | contato global, `ticket_id`, `order_item_id`, `orders`/`payments` e `tickets` |
| Confirmação administrativa | `registration_status` no participante | status do item/ingresso e pagamento canônico |
| RPCs antigas de importação | `upsert_current_event_import_participant`, `create_pending_imported_participant` e `create_imported_order_and_issue_ticket` | desativadas e sem `EXECUTE` para `authenticated` |

## LEGADO NECESSÁRIO

| Espelho limitado | Consumidor comprovado | Limite |
| --- | --- | --- |
| Identidade event-scoped criada por `create_registration`, emissão manual e atribuição de titular | busca histórica de Cadastros, Central e Retirada ainda relaciona `tickets.participant_id`/`order_items.participant_id` e usa a projeção quando registros antigos não têm contato completo | snapshot inicial; alterações pessoais posteriores não voltam ao participante |
| `participants.user_id` | convite de primeiro acesso, autorização do portal e descoberta dos contatos globais pertencentes à conta | somente vínculo de conta por `link_participant_account_projection`/claim; não replica dados pessoais |
| `participants.notes` | ficha antiga de inscrição (`/inscricoes/[id]`) | anotação interna do evento, sem significado de pessoa, ingresso ou pagamento |
| Campos históricos lidos por Operações/Retirada | fallback explícito para ingressos anteriores a `order_items`/`registration_contacts` completos | leitura apenas; novos escritores não dependem deles |
| Mirrors de pagamento/status em RPCs históricas (`start_payment_pix`, `cancel_registration_payment`, `admin_update_payment_status`, liberação de reserva) | telas históricas de inscrição/Retirada ainda exibem snapshots em registros antigos | a mesma transação atualiza primeiro `payments`/`orders`/`order_items`/`tickets`; o snapshot não é usado para decidir o novo estado canônico |

## BLOQUEADOR

Nenhum no escopo da Fase 2. A migration `20260815004500_close_phase2_lint_blockers.sql`
removeu os seis erros funcionais: pagamento, atribuição de titular, emissão manual,
cupom, check-in e entrega combinada agora usam as entidades ticket-first/contact-first.

`coupon_redemptions.participant_id` permanece como chave histórica exigida pelo schema
e pela unicidade já implantada de resgate por inscrição. Ela identifica somente a
projeção que originou o resgate; valores e estados são gravados exclusivamente em
`payments`, `orders`, `order_items` e `tickets`.
