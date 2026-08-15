# Diagnóstico da política de eventos

Data da revisão: 11/08/2026. Escopo estritamente somente leitura; nenhuma função, tabela ou dado foi alterado.

## Causa comprovada

Há duas imposições independentes de evento ativo único:

1. `015_events_and_kit_items.sql` cria o índice parcial global `ux_events_single_active` sobre a constante `(1) where is_active = true`. Portanto o banco admite no máximo um evento ativo em todas as organizações.
2. `set_event_active` e `update_event` desativam os demais eventos ao ativar um alvo. A definição mais recente de `create_event`, em `069_events_organization_scope.sql`, também executa `update public.events set is_active=false where is_active=true`, sem filtro de organização.

Não foi encontrado trigger que imponha unicidade de evento ativo. O trigger de `events` normaliza nome/slug/datas; a imposição é feita pelo índice e pelas funções.

`archive_event` não representa arquivamento: apenas grava `is_active=false` e `registration_enabled=false`. Não existe coluna canônica `archived_at`, `archived_by` ou estado equivalente. Assim, inatividade, vendas fechadas e arquivamento não são distinguíveis.

As RPCs legadas de atualização/ativação/arquivamento foram concedidas a `anon` e `authenticated` na migration 015 e seus corpos não fazem validação canônica de RBAC/organização. A UI oculta controles, mas isso não substitui autorização dentro da função. A `create_event` atual recebe `organization_id`, porém não valida dentro da RPC o acesso do ator à organização.

## Semântica atualmente observada

| Conceito | Representação | Independência real |
|---|---|---|
| Ativo | `events.is_active` | Não: globalmente exclusivo |
| Publicado/visível no portal | policy 091 exige ativo, vendas habilitadas e janela aberta | Acoplado a ativo e vendas |
| Vendas habilitadas | `registration_enabled` | Toggle separado; janela também interfere |
| Janela de vendas | `registration_open_at`, `registration_close_at` | Separada |
| Destaque/ordem | `event_highlights.is_active`, `sort_order` | Separada |
| Arquivado | Sem campo próprio | Confundido com inativo + vendas fechadas |
| Evento da importação | `import_batches.event_id` | Persistido explicitamente, mas validado tarde |
| Evento operacional selecionado | URL ou primeiro ativo/primeiro registro | Ambíguo em vários módulos |

## Inventário do evento principal

Campos comprovados em migrations: `id`, `organization_id`, `name`, `slug`, `year`, `description`, `starts_at`, `ends_at`, `registration_open`, `registration_close`, `registration_open_at`, `registration_close_at`, `location`, `is_active`, `registration_enabled`, `kit_enabled`, `allow_checkin_during_kit_delivery`, `shirt_order_deadline`, `limit_shirt_selection_to_stock`, `wristband_enabled`, `allow_participant_item_changes`, `allow_holder_change`, `allow_ticket_transfer`, `created_at`, `updated_at`.

O formulário geral edita nome, slug, ano, descrição, datas, janela, local, ativo, vendas e kit. Configurações ausentes desse formulário são distribuídas por telas/RPCs específicas ou não aparecem: check-in durante entrega, prazo de camiseta, limitação por estoque, pulseiras, alterações de itens pelo participante e regras de titularidade/transferência.

Configurações relacionadas, em tabelas próprias: categorias, lotes comerciais e preços, itens/variantes/inventário do kit, métodos de pagamento, cupons, adicionais, cronograma, destaques, pulseiras e regras de importação.

Permissões canônicas encontradas: `events.create`, `events.edit`, `events.publish`, `events.archive`; leitura usa `events.view` onde disponível. Configurações especializadas também exigem permissões do domínio (por exemplo kit/inventário), mas algumas RPCs antigas não repetem a verificação dentro do banco.

## Matriz de fluxos afetados

| Fluxo | Seleção atual | Risco com vários ativos |
|---|---|---|
| Importação | select explícito e `import_batches.event_id`; validação obrigatória ocorre tarde | lote pode ser criado sem evento antes de falhar; texto “evento atual” é ambíguo |
| Cadastro público | `getActiveEventId()` com `maybeSingle()` global | falha com mais de um ativo; não há organização/evento explícito |
| Painel | URL, senão primeiro ativo, senão primeiro evento | escolha silenciosa dependente da ordenação |
| Inscrições/Cadastros | filtro explícito em parte; telas legadas usam fallback | contexto pode mudar sem intenção do operador |
| Financeiro/Cupons/Gestão de eventos | ativo por `maybeSingle()` | erro quando houver dois ativos |
| Pedidos/Relatórios/Operações/Camisetas | explícito, senão primeiro ativo/primeiro evento | relatório/operação pode usar evento errado |
| Emissão/checkout | operações modernas propagam `event_id` | entrada ainda depende de seletor implícito em fluxos legados |
| Dashboard/capacidades/sidebar | ativo mais recente com `LIMIT 1` | recursos exibidos conforme evento arbitrário |
| Cronograma | dados são escopados por `event_id` | consumidor precisa receber evento explícito |
| Portal público | policies exigem ativo + vendas + janela; rota pública resolve slug | múltiplos publicados são possíveis após correção, mas inscrição não pode usar “ativo atual” |
| Ingresso/pedido/participante/lote | tabelas preservam `event_id` | fallbacks de nome como “Evento”/“Evento Militrin” mascaram vínculo ausente |

## Riscos e ambiguidades

- **Crítico:** desativação global e cruzada entre organizações.
- **Crítico:** RPCs administrativas legadas sem RBAC/organização dentro do `security definer` e grants amplos.
- **Alto:** `maybeSingle()` e `LIMIT 1` para escolher ativo quebram ou selecionam arbitrariamente após permitir múltiplos.
- **Alto:** arquivamento não possui estado próprio e altera vendas como efeito colateral.
- **Alto:** importação só rejeita ausência de evento em fase posterior; o lote guarda o UUID, mas a entrada deve falhar antes de qualquer processamento.
- **Médio:** `is_active` significa disponibilidade administrativa e também participa da publicação pública.
- **Médio:** fallbacks genéricos de nome escondem inconsistência de `event_id` em ingresso/relatórios.
- **Médio:** campos de configuração estão fragmentados e as permissões não são apresentadas como matriz na edição.

## Direção segura (não implementada)

Uma migration será necessária para remover a exclusividade global e substituir as RPCs por operações com autenticação, organização e RBAC. Antes dela, é necessário fechar o contrato de arquivamento explícito e migrar todos os consumidores para seleção obrigatória por UUID. A correção não deve escolher evento por nome, slug, `LIMIT 1` ou “único ativo”; slug pode continuar somente como identificador explícito de uma rota pública, nunca como fallback operacional.

O SQL `109_event_policy_diagnostic.sql` comprova o estado ativo. O preflight preliminar separa pré-requisitos estruturais de bloqueadores da política futura.
