import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const remoteSchemaUrl = new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url);
const shirtConfiguratorMigrationUrl = new URL('../supabase/migrations/20260864000000_shirt_kit_item_model_size_configurator.sql', import.meta.url);
const eventosActionsUrl = new URL('../src/app/eventos/actions.ts', import.meta.url);
const eventKitManagerUrl = new URL('../src/app/eventos/[eventSlug]/ui.tsx', import.meta.url);
const shirtConfiguratorUiUrl = new URL('../src/app/painel/eventos/[id]/shirt-kit-configurator.tsx', import.meta.url);
const eventDetailPageUrl = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);
const shirtConstantsUrl = new URL('../src/lib/constants/shirts.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// Causa raiz do bug original ("Falha ao salvar item do kit" ao adicionar
// Camiseta): o trigger existente rejeita item_type='shirt' ativo sem
// shirt_supply_mode. Este teste documenta que o trigger continua existindo
// e continua sendo a regra que o novo fluxo precisa satisfazer -- nunca foi
// removido/enfraquecido para "resolver" o bug escondendo o erro.
test('causa raiz: trigger enforce_explicit_shirt_supply_mode continua exigindo shirt_supply_mode para camiseta ativa', async () => {
  const sql = await readFile(remoteSchemaUrl, 'utf8');
  assert.match(sql, /if new\.item_type='shirt' and new\.is_active and new\.shirt_supply_mode is null then/);
  assert.match(sql, /raise exception 'Camiseta ativa exige modo stock, made_to_order ou disabled\.';/);
});

test('save_event_shirt_kit_configuration sempre grava shirt_supply_mode nao-nulo (insert e update), resolvendo a causa raiz', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /if p_supply_mode is null or p_supply_mode not in \('stock', 'made_to_order', 'disabled'\) then/);
  assert.match(fn, /shirt_supply_mode\s*\)\s*values\s*\(\s*p_event_id, 'Camiseta', 'camiseta', 'shirt'.*p_supply_mode/s);
  assert.match(fn, /set shirt_supply_mode = p_supply_mode/);
});

test('save_event_shirt_kit_configuration reaproveita a UNICA linha shirt do evento (nunca cria uma segunda)', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /where event_id = p_event_id and item_type = 'shirt'\s*\n\s*limit 1;/);
  assert.match(fn, /if v_kit_item_id is null then\s*\n\s*insert into public\.event_kit_items/);
});

test('save_event_shirt_kit_configuration valida modelo e tamanho contra as listas fixas (nunca aceita valor livre)', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /if v_shirt_type not in \('Camiseta', 'Babylook'\) then/);
  assert.match(fn, /if v_shirt_size not in \('PP', 'P', 'M', 'G', 'GG', 'EG', 'EXG', 'EXGG'\) then/);
});

test('save_event_shirt_kit_configuration materializa SOMENTE tabelas ja existentes (nenhuma tabela nova, nenhum saldo duplicado)', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /insert into public\.event_kit_item_variants/);
  assert.match(fn, /insert into public\.event_kit_item_variant_inventory[\s\S]*?on conflict \(kit_item_id, variant_id\) do nothing;/);
  assert.match(fn, /insert into public\.shirt_inventory[\s\S]*?on conflict \(event_id, shirt_type, shirt_size\) do nothing;/);
  assert.doesNotMatch(sql, /create table/i);
});

test('remocao de tamanho desmarcado: so apaga (variante + os 2 saldos) quando NAO ha movimentacao em nenhuma das duas tabelas canonicas', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(
    fn,
    /if coalesce\(v_kit_inv\.total_quantity, 0\) = 0 and coalesce\(v_kit_inv\.reserved_quantity, 0\) = 0[\s\S]*?and coalesce\(v_stock_inv\.delivered_quantity, 0\) = 0 then/,
  );
  assert.match(fn, /delete from public\.event_kit_item_variants where id = v_existing\.id;/);
});

test('remocao bloqueada: tamanho com movimentacao so e DESATIVADO (is_active=false), nunca perde dado real -- e o motivo e devolvido ao chamador', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /update public\.event_kit_item_variants set is_active = false where id = v_existing\.id;/);
  assert.match(fn, /'reason', 'Ja existe estoque, reserva ou entrega registrada para este tamanho\.'/);
  assert.match(fn, /return jsonb_build_object\('kit_item_id', v_kit_item_id, 'blocked_removals', v_blocked\);/);
});

test('save_event_shirt_kit_configuration exige events.edit + acesso a organizacao (mesmo padrao de set_event_wristband_settings)', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'save_event_shirt_kit_configuration');
  assert.match(fn, /not public\.current_user_has_permission\('events\.edit'\)/);
  assert.match(fn, /not public\.user_can_access_organization\(v_actor, v_event\.organization_id\)/);
});

test('get_event_shirt_kit_configuration exige events.view + acesso a organizacao e devolve variantes inativas tambem (para explicar bloqueios ao reabrir)', async () => {
  const sql = await readFile(shirtConfiguratorMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'get_event_shirt_kit_configuration');
  assert.match(fn, /not public\.current_user_has_permission\('events\.view'\)/);
  assert.match(fn, /not public\.user_can_access_organization\(v_actor, v_event\.organization_id\)/);
  assert.doesNotMatch(fn, /and v\.is_active/);
});

test('saveEventShirtKitConfigurationAction valida com zod (min 1 tamanho) e chama save_event_shirt_kit_configuration, nunca upsert_event_kit_item', async () => {
  const source = await readFile(eventosActionsUrl, 'utf8');
  const startIndex = source.indexOf('export async function saveEventShirtKitConfigurationAction');
  assert.ok(startIndex >= 0, 'saveEventShirtKitConfigurationAction nao encontrada');
  const fnBody = source.slice(startIndex, startIndex + 1600);
  assert.match(fnBody, /supabase\.rpc\("save_event_shirt_kit_configuration"/);
  assert.doesNotMatch(fnBody, /upsert_event_kit_item/);
  assert.match(source, /pairs: z\.array\(shirtKitPairSchema\)\.min\(1, "Selecione ao menos um tamanho\."\)/);
});

test('saveEventShirtKitConfigurationAction revalida /camisetas (Estoque) alem das rotas de evento', async () => {
  const source = await readFile(eventosActionsUrl, 'utf8');
  const startIndex = source.indexOf('export async function saveEventShirtKitConfigurationAction');
  const fnBody = source.slice(startIndex, startIndex + 1600);
  assert.match(fnBody, /revalidatePath\("\/camisetas"\)/);
});

test('form generico de itens de kit nao oferece mais "Camiseta" -- so o configurador dedicado pode criar item_type shirt', async () => {
  const source = await readFile(eventKitManagerUrl, 'utf8');
  const itemTypesStart = source.indexOf('const itemTypes = [');
  const itemTypesEnd = source.indexOf('];', itemTypesStart);
  const itemTypesBlock = source.slice(itemTypesStart, itemTypesEnd);
  assert.doesNotMatch(itemTypesBlock, /value: "shirt"/);
});

test('Etapa 6 filtra item_type shirt para fora do EventKitManager generico e renderiza ShirtKitConfigurator antes dele', async () => {
  const source = await readFile(eventDetailPageUrl, 'utf8');
  assert.match(source, /import \{ ShirtKitConfigurator \} from "\.\/shirt-kit-configurator";/);
  const configuratorIndex = source.indexOf('<ShirtKitConfigurator');
  const managerIndex = source.indexOf('<EventKitManager');
  assert.ok(configuratorIndex >= 0 && managerIndex >= 0, 'os dois componentes precisam estar montados');
  assert.ok(configuratorIndex < managerIndex, 'ShirtKitConfigurator deve vir antes de EventKitManager na Etapa 6');
  assert.match(source, /items\.filter\(\(item: \{ item_type: string \}\) => item\.item_type !== "shirt"\)/);
});

test('leitura de get_event_shirt_kit_configuration esta encadeada no Promise.all da pagina do evento', async () => {
  const source = await readFile(eventDetailPageUrl, 'utf8');
  assert.match(source, /supabase\.rpc\("get_event_shirt_kit_configuration", \{ p_event_id: id \}\)/);
});

test('ShirtKitConfigurator usa a matriz oficial de 8 tamanhos e as 2 opcoes de modelo pedidas (sem "somente Babylook")', async () => {
  const source = await readFile(shirtConfiguratorUiUrl, 'utf8');
  assert.match(source, /import \{ OFFICIAL_SHIRT_SIZE_ORDER, type ShirtType \} from "@\/lib\/constants\/shirts";/);
  assert.match(source, /OFFICIAL_SHIRT_SIZE_ORDER\.map\(\(size\) =>/);
  assert.match(source, />Somente Camiseta</);
  assert.match(source, />Camiseta \+ Babylook</);
  assert.doesNotMatch(source, /Somente Babylook/);
});

test('ShirtKitConfigurator so materializa pares MARCADOS (nenhum tamanho oculto/nao selecionado e enviado ao salvar)', async () => {
  const source = await readFile(shirtConfiguratorUiUrl, 'utf8');
  assert.match(source, /for \(const size of selectedSizes\[model\]\) pairs\.push\(\{ shirt_type: model, shirt_size: size \}\);/);
  assert.match(source, /if \(pairs\.length === 0\) \{/);
});

test('ShirtKitConfigurator mostra o motivo de tamanhos que nao puderam ser removidos (destrutivo bloqueado)', async () => {
  const source = await readFile(shirtConfiguratorUiUrl, 'utf8');
  assert.match(source, /blockedRemovals\.map\(\(item\) =>/);
  assert.match(source, /Alguns tamanhos não puderam ser removidos:/);
});

test('SHIRT_TYPES/OFFICIAL_SHIRT_SIZE_ORDER continuam a fonte unica reaproveitada (Camiseta\\/Babylook e PP..EXGG), nenhuma lista paralela criada', async () => {
  const source = await readFile(shirtConstantsUrl, 'utf8');
  assert.match(source, /export const SHIRT_TYPES = \["Camiseta", "Babylook"\] as const;/);
  assert.match(source, /export const OFFICIAL_SHIRT_SIZE_ORDER = \["PP", "P", "M", "G", "GG", "EG", "EXG", "EXGG"\] as const;/);
});
