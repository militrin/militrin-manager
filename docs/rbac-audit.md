# Auditoria RBAC do painel administrativo

Auditoria estática concluída em 2026-08-23 sobre páginas, layouts, Server Actions, componentes clientes, helpers JS e funções/RPCs presentes nas migrations. Nenhuma alteração remota, `db push`, commit ou deploy foi executado.

## Modelo canônico

- `resolve_user_permission`: usuário inativo não opera; Owner tem bypass; override `deny` prevalece sobre `allow`; depois vale a permissão herdada da função.
- `hasPermission`: consulta a permissão efetiva atual.
- `requirePermission`/`requireAnyPermission`: protegem páginas e URLs diretas com redirect para `/acesso-negado`.
- `assertPermission`: protege Server Actions antes de validação e mutação.
- RLS/RPC: continua sendo a autoridade final e deve também validar organização.
- `admin_users` define acesso funcional; `organization_members` limita onde o usuário opera.

## Matriz

| Módulo | Rotas principais | Visualização | Mutações |
|---|---|---|---|
| Dashboard | `/painel`, `/painel/detalhes` | ao menos uma `dashboard.*.view` de bloco | ações e detalhes exigem a permissão do bloco e do módulo sensível |
| Integridade | `/painel/integridade` | `integrity.view` | somente diagnóstico |
| Público/recorrência | `/painel/usuarios` | `participants.view` | somente leitura |
| Eventos | `/painel/eventos`, `/painel/eventos/[id]` | `events.view` | `events.create`, `events.edit`, `events.publish`, `events.archive` |
| Categorias | `/categorias`, etapa do evento | `categories.view` | `categories.create`, `categories.edit`, `categories.delete` |
| Lotes | `/lotes`, etapa do evento | `batches.view` | `batches.create`, `batches.edit`, `batches.activate`, `batches.delete` |
| Atrações/Cronograma | etapas do evento, `/painel/cronograma-entregas` | `events.view` | `events.edit` |
| Cadastros | `/cadastros/**` | `participants.view` | `participants.create`, `participants.edit_basic`, `participants.edit_sensitive`, `participants.cancel`, `participants.export` |
| Ingressos | `/ingressos/**` | `participants.view` ou `orders.view` | emissão `participants.create`; titular `participants.edit_basic`; propriedade `tickets.transfer_ownership`; cancelamento `orders.cancel` |
| Pedidos | `/pedidos` | `orders.view` | `orders.edit`, `orders.cancel`, `orders.resend_ticket` |
| Financeiro | `/financeiro` | `finance.view`; valores `finance.view_amounts` | `finance.confirm_payment`, `finance.refund`, `finance.reconcile`, `finance.manage_*`, `finance.export` |
| Estoque/camisetas | `/camisetas` | `inventory.view`; histórico `inventory.view_history` | `inventory.adjust`, `inventory.limit_selection`, `inventory.reset`, `inventory.clear_history`, `inventory.change_participant_shirt` |
| Kit | `/operacoes` | `kits.view` | `kits.deliver`, `kits.undo_delivery`, `kits.replace_item` |
| Pulseiras/check-in | `/operacoes`, `/operacoes/pulseira` | `wristbands.view`, `checkin.view` | `wristbands.link/unlink/replace/block`, `checkin.scan/undo` |
| Loja | `/loja` | `store.view` | `store.manage`, `store.grant_items` |
| Pedidos da loja | `/loja/pedidos/**` | `store.view` | `store.deliver`, `store.manage` |
| Cupons | `/cupons` | `coupons.view`; uso `coupons.view_usage` | `coupons.create`, `coupons.edit`, `coupons.disable` |
| Importações | `/importacoes` | `imports.view` | `imports.create`, `imports.review`, `imports.rollback` |
| Relatórios | `/relatorios`, API de exportação | `reports.view` + permissão do relatório | `reports.export` + permissão do relatório |
| Fotos | `/fotos/**` é galeria pública | conteúdo público publicado | permissões administrativas `photos.upload/publish/delete` ainda sem UI administrativa implementada |
| Patrocinadores | `/painel/patrocinadores` | `sponsors.view` | `sponsors.manage` |
| Feedbacks | `/painel/feedbacks` | `feedback.view` | `feedback.manage` |
| Equipe/funções | `/painel/configuracoes/equipe/**` | `team.view` | fluxo atual usa `team.edit_permissions`; `team.invite/edit_role/disable_user` são parcialmente aplicados no RPC |
| Configurações | `/configuracao` | `settings.manage` | `settings.manage` |
| Operações/Turbo | `/operacoes`, `/operacoes/turbo` | ao menos uma permissão operacional | cada botão usa sua capability e cada action revalida o mesmo código |

`/retirada` não é fluxo operacional independente: é rota legada de compatibilidade que autentica e redireciona para `/operacoes`.

## Bugs corrigidos

1. Estoque oferecia encomenda, ajuste e histórico a perfis somente leitura. Agora cada controle recebe sua capability do Server Component.
2. Encomenda validava `inventory.add_order`, código ausente do RBAC atual, enquanto o RPC usa `inventory.adjust`. UI e action agora usam `inventory.adjust`.
3. Limpeza de histórico exigia Owner hardcoded em produção apesar de `inventory.clear_history`. A exceção foi removida; action e RPC usam o código canônico.
4. Dashboard, detalhes, eventos e cronograma aceitavam URL direta apenas com o guard amplo do painel. As páginas agora revalidam a permissão específica.
5. A listagem de eventos mostrava criar/editar/publicar/arquivar para `events.view`. Os controles agora são independentes.
6. Server Actions de eventos, categorias, lotes, cupons e financeiro dependiam somente da RPC. Agora revalidam permissões antes da chamada.
7. Usuário promovido podia ter `admin_users` sem `organization_members`, causando 500 no dashboard. A migration `20260877000000` materializa o vínculo, faz backfill e o dashboard tem fallback amigável.

## Gaps documentados

- Os presets reais devem ser revisados manualmente: a auditoria somente leitura encontrou o papel `administrator` sem `dashboard.view`, `finance.*`, `imports.*`, `settings.manage`, `feedback.*` e `sponsors.manage`. Não foram alterados, conforme solicitado.
- `team.invite` e `team.edit_role` permanecem subutilizados porque o RPC canônico agrega edição de função, status e overrides numa chamada. Separar isso exige evolução de contrato/migration para não criar autorização parcial enganosa.
- As permissões administrativas de Fotos não possuem ainda uma tela administrativa; `/fotos` é deliberadamente público.
- Algumas RPCs históricas de configuração de evento anteriores ao endurecimento atual ainda precisam de auditoria dinâmica contra o schema remoto antes de qualquer `CREATE OR REPLACE`; o relatório não presume que o dump baseline representa sozinho o estado remoto.

## Validação esperada

- Testes de contrato: `tests/admin-rbac-audit.test.mjs`.
- Testes existentes cobrem menu, Owner, overrides, usuário inativo, organização, concessão da loja, operações e editor de funções.
- Validação remota por perfil não foi executada porque a tarefa proíbe alterar presets, aplicar migrations ou operar o banco.

## Funções padrão consolidadas

A migration `20260879000000_consolidate_admin_roles.sql` reduz os presets ativos a seis. Roles antigas são desativadas somente depois da migração dos membros. Usuários existentes passam a herdar o preset final correspondente; seus overrides individuais existentes permanecem intactos e continuam com precedência.

| Função final | Roles de origem | Área | Permissões/ações padrão |
|---|---|---|---|
| Owner | Owner | Sistema inteiro | bypass canônico de Owner; nenhuma permissão perdida |
| Administrador | Administrator, Manager, Inventory | Administração ampla | todas as permissões ativas; operações exclusivas de Owner continuam exigindo `is_active_owner` |
| Operacional | Check-in, Kit Delivery, Support | Atendimento e evento | pessoas, pedidos em leitura, reenvio, check-in, entrega de kit, históricos, pulseira, correção de camiseta e entrega da loja |
| Financeiro | Finance | Financeiro | valores, pagamentos, receitas, despesas, conciliação, estorno e exportações |
| Marketing | Marketing | Conteúdo | eventos em leitura, fotos, patrocinadores e relatórios não financeiros; nenhum bloco do Dashboard por padrão |
| Visualizador | Viewer | Leitura mínima | blocos Pessoas e Operação, pessoas/inscrições e pedidos em leitura; ampliações ficam em overrides |

### Ações fora do preset Operacional

| Risco/ação | Permissão | Decisão |
|---|---|---|
| Desfazer check-in | `checkin.undo` | override explícito |
| Desfazer entrega | `kits.undo_delivery` | override explícito |
| Ajuste/reset/limpeza de estoque | `inventory.adjust`, `inventory.reset`, `inventory.clear_history` | Administrador ou override explícito |
| Transferir propriedade do ingresso | `tickets.transfer_ownership` | override explícito; não confundir com correção básica de titular |
| Cancelar participante/pedido | `participants.cancel`, `orders.cancel` | Administrador ou override explícito |
| Estorno/alteração financeira | `finance.*` de mutação | Financeiro/Administrador |
| Equipe e permissões | `team.*` | Administrador; Owner nas proteções exclusivas |

## Dashboard por bloco

| Bloco | Permissão de seção | Permissão adicional | Funções padrão |
|---|---|---|---|
| Integridade operacional | `dashboard.integrity.view` | `integrity.view` | Owner, Administrador |
| Pessoas e inscrições | `dashboard.people.view` | `participants.view` nos links/recorrência | Owner, Administrador, Operacional, Visualizador |
| Ingressos e operação | `dashboard.operations.view` | permissões específicas nas ações | Owner, Administrador, Operacional |
| Estoque de camisetas | `dashboard.inventory.view` | permissões específicas nas ações | Owner, Administrador |
| Financeiro | `dashboard.finance.view` | `finance.view_amounts` para carregar valores | Owner, Administrador, Financeiro |

`loadAdminDashboard` recebe somente os blocos autorizados. Consultas de pagamentos, estoque, ingressos e operação não são disparadas para blocos ausentes. Integridade também não chama sua RPC sem ambas as permissões. `/painel/detalhes` valida o bloco antes de consultar dados.

## Equivalência e compatibilidade

| Role antiga | Destino |
|---|---|
| `owner` | `owner` |
| `administrator` | `administrator` (Administrador) |
| `manager` | `administrator` |
| `inventory` | `administrator` |
| `finance` | `finance` (Financeiro) |
| `checkin` | `operational` |
| `kit_delivery` | `operational` |
| `support` | `operational` |
| `marketing` | `marketing` |
| `viewer` | `viewer` (Visualizador) |

`resolve_user_permission` continua sendo a única fonte de permissão efetiva: Owner, override `deny`, override `allow`, role e false. A migration não recria essa função nem apaga `admin_user_permission_overrides`.
