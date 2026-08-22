-- Corrige violacao em producao ao criar o Primeiro Lote de ingresso unico num
-- evento que ja tinha o Segundo Lote:
--   duplicate key value violates unique constraint "ux_registration_batches_single_active"
--   Key (event_id)=(...) already exists.
--
-- AUDITORIA (causa raiz):
--   ux_registration_batches_single_active e um indice unico parcial LEGADO,
--   criado no dump base (20260815001914_remote_schema.sql:17177):
--     CREATE UNIQUE INDEX ux_registration_batches_single_active
--       ON registration_batches (event_id) WHERE is_active;
--   Ele modela o mundo anterior a esta feature: "no maximo 1 lote pode estar
--   is_active=true por evento" -- verdadeiro tanto para o fluxo COM categoria
--   (create_registration_batch desativa todos os outros lotes do evento antes
--   de ativar um novo, entao so exigia 1 slot) quanto para o antigo fluxo SEM
--   categoria de preco fixo (set_event_single_ticket_price/
--   confirm_registration_batch_flat_price, ambos removidos por
--   20260865000000, so atualizavam OU criavam o unico lote is_active do
--   evento -- nunca um segundo).
--
--   A migration 20260865000000 (single_ticket_multi_batch_gender_split)
--   introduziu create_single_ticket_batch, que deliberadamente insere CADA
--   lote novo com is_active=true e NUNCA desativa os demais (comentario da
--   propria migration, linhas 20-24: "os novos lotes de ingresso unico sao
--   criados por RPCs novas e dedicadas, is_active sempre true, nunca
--   competindo por um unico slot 'is_active'"). Ela auditou e reescreveu toda
--   a resolucao de preco/checkout (resolve_single_ticket_batch_for_gender,
--   get_registration_pricing_preview, assign_single_ticket_batch_by_gender,
--   list_single_ticket_batches, get_single_ticket_current_batches) para o
--   novo modelo -- mas NAO tocou o indice unico legado do passo anterior, que
--   continuou brigando pelo mesmo unico slot "is_active=true por evento" e
--   passou a rejeitar o 2o, 3o, 4o... lote de ingresso unico criado no mesmo
--   evento. Essa e a causa raiz do bug relatado.
--
-- INVARIANTE QUE PRECISA SER PRESERVADA (nao e so um DROP INDEX cru):
--   O fluxo COM categoria (BatchesManager em src/app/lotes/,
--   create_registration_batch, create_registration_batch_with_prices) NAO
--   MUDOU de regra nesta correcao: continua "1 lote ativo por vez",
--   controlado pela propria RPC (que desativa os demais antes de inserir/
--   ativar um novo). O indice legado tambem funcionava como rede de seguranca
--   contra bug futuro nesse fluxo -- essa rede precisa continuar existindo,
--   so que sem enxergar os lotes de ingresso unico multi-lote.
--
--   Um lote de ingresso unico (fluxo SEM categoria) e distinguido de um lote
--   do fluxo COM categoria por flat_price_confirmed=true: essa coluna (de
--   20260815006200) so e setada true por create_single_ticket_batch e
--   update_single_ticket_batch, ambos SEMPRE aplicados a lotes sem nenhuma
--   linha em registration_batch_prices (fluxo com categoria nunca seta essa
--   coluna, permanece default false) -- e o mesmo predicado que
--   resolve_single_ticket_batch_for_gender e get_registration_pricing_preview
--   ja usam para reconhecer "isto e um lote de ingresso unico". Um indice
--   parcial nao pode fazer EXISTS contra outra tabela (registration_batch_prices)
--   no WHERE, entao flat_price_confirmed e o proxy correto e ja estabelecido
--   pelo restante do codigo para essa distincao.
--
--   Novo indice: unico (event_id) WHERE is_active AND NOT flat_price_confirmed.
--   - Lotes com categoria (flat_price_confirmed sempre false): continuam
--     restritos a 1 ativo por evento, como antes.
--   - Lotes de ingresso unico (flat_price_confirmed sempre true quando
--     criados/atualizados pelas RPCs atuais): ficam FORA do indice, podem
--     coexistir varios com is_active=true no mesmo evento -- exatamente o
--     que a feature de multiplos lotes precisa.
--   - registration_batches_sequence_unique (event_id, sequence_number), ja
--     existente, continua garantindo que nao ha 2 lotes com o mesmo numero
--     de ordem no mesmo evento -- essa e a identidade/unicidade real de
--     "qual lote e qual" no novo modelo, preservada sem alteracao.
begin;

drop index if exists public.ux_registration_batches_single_active;

create unique index ux_registration_batches_single_active_categorized
  on public.registration_batches (event_id)
  where is_active and not flat_price_confirmed;

comment on index public.ux_registration_batches_single_active_categorized is
  'Restringe a 1 lote ativo por evento apenas no fluxo COM categoria (registration_batch_prices). Lotes de ingresso unico (flat_price_confirmed=true, ver create_single_ticket_batch) ficam de fora deliberadamente: varios podem estar is_active=true ao mesmo tempo, um por faixa de preco/genero, preservando historico (20260866000000).';

commit;
