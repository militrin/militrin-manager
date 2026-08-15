# Diagnóstico separado — snapshots de titular sem vínculo canônico

Nenhuma regularização histórica é executada pela migration `20260815005200`. Ela altera somente novos checkouts.

## Não recuperáveis sem identificador adicional

- Heloisa Crestani — `ticket_id=1dd3070c-95aa-40cc-a99c-f41548396e16`, `order_item_id=16df3bdd-1840-498d-8c9d-07629fedc13a`.
- Silvana Hobold — `ticket_id=44c72de7-354c-4683-92f4-f70ed4c9ce61`, `order_item_id=58b7f2bb-5f60-4fb3-8d65-beafbc821501`.

Ambos possuem apenas `holder_full_name`, sem `participant_id` e sem `registration_contact_id`. A proposta é manter `Titular não definido`, abrir a pendência `insufficient_named_holder_identity` e solicitar CPF válido, cadastro explicitamente escolhido ou e-mail+telefone para criação deliberada. Não criar contato nem fazer merge pelo nome.

## Recuperáveis por vínculo já comprovado

- Maria Carolina Liscoski — item `c904a5a9-6c85-42bf-8ed2-5dbef47e6e57`, ticket `9246e7d0-302b-4dbc-aa60-731017b0ceef`, participant `d9cf7f4a-d3a5-46a7-a420-11503c8a7043`, contact `79bf445c-e86f-4f89-abcc-110e6135ca60`.
- Cidiclei Rother — item `aa86fc38-c931-4398-8c87-6389329d7f51`, ticket `77ca4b86-7791-42a4-b050-b602a4738bb1`, participant `29ce6250-6ac7-4e49-aebc-a817ce602205`, contact `610d8386-192c-46e7-bb91-c82032e30666`.
- Teste Importação F2 — item `d4fd582d-9c4c-4698-ae82-659a7cf7191a`, ticket `86825375-30c1-4e82-83ac-be080b2b1a5c`, participant `c1826944-e040-4f4f-bdbc-0ab3c6afbc0e`, contact `5d9ffdb3-cb7b-4ca7-9e89-e0c0438386aa`.
- Douglas Hobold — item `081dc0ee-c5fa-4045-8023-907fcb7b11bb`, ticket `dff88449-a457-4609-bb36-ccb35c023889`, participant `b2b4b9f2-1cab-452a-b76d-5380e631e348`, contact `91b9bc32-67d-4ffb-8354-598b842bf559`.

Backfill seguro proposto, ainda não executado: travar item/ticket/participant/contact; confirmar mesma organização e evento; confirmar que o participant continua ligado ao contact indicado; bloquear se o contact já for titular de outro ingresso ativo no evento; preencher `order_items.registration_contact_id`, manter o `participant_id`, marcar `ownership_status=assigned`, propagar `participant_id` ao ticket e registrar auditoria com valores anteriores e novos. O `owner_user_id` do ticket permanece intocado.
