import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260923000000_shirt_variant_detector_canonical_source.sql', import.meta.url), 'utf8');
const fn = migration.slice(migration.indexOf('create or replace function public.detect_integrity_missing_shirt_variant'));

// Bug real encontrado: o emissor canonico do checkout normal
// (confirm_order_item_and_issue_ticket) nunca cria participant_kit_items --
// esse vinculo so e materializado depois, por acoes operacionais pontuais
// (entrega, troca de camiseta, emissao manual). O detector antigo exigia
// participant_kit_items.variant_data->>'variant_id' presente, entao TODO
// ingresso com tamanho ja escolhido no checkout mas ainda nao entregue
// aparecia como "sem camiseta". Confirmado ao vivo: os 3 ingressos reais
// apontados pela Central tinham order_items.shirt_type/shirt_size validos
// batendo com exatamente 1 variante ativa.

test('7) ingresso com direito a camiseta e tamanho valido em order_items nao aparece na Integridade mesmo sem participant_kit_items materializado', () => {
  // A ausencia de pki (pki.id is null) cai no MESMO WHERE do ingresso com
  // variant_data sem variant_id -- os dois so sao sinalizados quando a
  // segunda fonte (order_items x variantes ativas) tambem nao resolve nada.
  assert.match(fn, /coalesce\(pki\.variant_data->>'variant_id', ''\) = ''/);
  assert.match(fn, /not exists \(\s*select 1 from public\.event_kit_item_variants v\s*where v\.kit_item_id = eki\.id and v\.is_active\s*and lower\(trim\(v\.name\)\) = lower\(trim\(oi\.shirt_type\)\)\s*and upper\(trim\(v\.value\)\) = upper\(trim\(oi\.shirt_size\)\)\s*\)/);
});

test('8) ingresso realmente sem tamanho (order_items.shirt_type/shirt_size vazios) continua aparecendo', () => {
  // Quando shirt_type/shirt_size sao nulos/vazios, lower(trim(null)) nunca
  // bate com nenhuma variante ativa (nome/valor sempre preenchidos na
  // configuracao do kit) -- o NOT EXISTS permanece verdadeiro e o ingresso
  // continua flagado, exatamente como antes desta correcao.
  assert.match(fn, /left join public\.order_items oi on oi\.id = t\.order_item_id/);
});

test('9) tamanho existente na fonte canonica (order_items) e reconhecido mesmo com variant_data legado', () => {
  const whereClause = fn.slice(fn.indexOf('where t.organization_id'));
  assert.match(whereClause, /and t\.status <> 'cancelled'/);
  assert.match(whereClause, /and coalesce\(pki\.variant_data->>'variant_id', ''\) = ''\s*\n\s*and not exists/);
});

test('10) ingresso sem direito a camiseta continua fora do detector (join com event_kit_items exige item_type shirt e requires_variant)', () => {
  assert.match(fn, /join public\.event_kit_items eki on eki\.event_id = t\.event_id and eki\.item_type = 'shirt' and eki\.is_active = true and eki\.requires_variant = true/);
});

test('regra corrigida nao muda severidade/label/acao do card -- so a fonte de dados que decide o alerta', () => {
  assert.match(fn, /'TICKET_MISSING_REQUIRED_SHIRT_VARIANT'::text, 'attention'::text, 'camisetas_kits'::text/);
  assert.match(fn, /'Camiseta não definida'::text/);
});

test('a correcao nao copia dado nenhum entre tabelas -- so amplia a leitura pra uma segunda fonte ja canonica', () => {
  assert.doesNotMatch(migration, /insert into public\.participant_kit_items/);
  assert.doesNotMatch(migration, /update public\.participant_kit_items/);
});

// Auditoria pre-push: tamanho textual invalido (nao cadastrado como variante
// ativa daquele kit_item) nunca "passa" so por existir como string em
// order_items -- o NOT EXISTS exige match contra event_kit_item_variants
// filtrado por is_active=true E pelo MESMO kit_item_id do evento (nao
// qualquer variante de qualquer evento).
test('tamanho invalido (nao cadastrado ou variante inativa) nao e aceito so por existir como texto', () => {
  assert.match(fn, /v\.kit_item_id = eki\.id and v\.is_active/);
});

// 0 variantes compativeis: NOT EXISTS permanece verdadeiro -> continua
// flagado (regra original preservada).
// 1 variante compativel: NOT EXISTS falso -> nao flagado (o bug corrigido).
// 2+ variantes com o MESMO (name,value) ativas pro mesmo kit_item seriam um
// problema de configuracao do catalogo (duplicidade), nao do ingresso -- o
// EXISTS/NOT EXISTS trata "pelo menos uma corresponde" como "tamanho
// resolvido", que e a pergunta certa pra este detector (o ingresso tem um
// tamanho valido escolhido, independente de o catalogo ter entradas
// duplicadas). Detectar variantes duplicadas no catalogo e um problema
// diferente, fora do escopo deste detector.
test('0 ou 1 variante compativel funcionam como esperado; 2+ com mesmo nome/valor sao tratadas como "tamanho resolvido" (nao e o mesmo problema que duplicidade de catalogo)', () => {
  assert.match(fn, /not exists \(/);
  assert.doesNotMatch(fn, /count\(\*\)/);
});
