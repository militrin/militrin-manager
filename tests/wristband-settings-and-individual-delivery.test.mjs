import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const wristbandOpsMigrationUrl = new URL('../supabase/migrations/20260848000000_wristband_requirement_and_reason_coded_undo.sql', import.meta.url);
const wristbandSettingsMigrationUrl = new URL('../supabase/migrations/20260849000000_event_wristband_settings_rpc.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const expandedDetailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const eventosActionsUrl = new URL('../src/app/eventos/actions.ts', import.meta.url);
const wristbandSettingsUiUrl = new URL('../src/app/painel/eventos/[id]/wristband-settings.tsx', import.meta.url);
const eventDetailPageUrl = new URL('../src/app/painel/eventos/[id]/page.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// Cenario 1 + 7: evento SEM pulseira -- nenhuma operacao deve depender de
// wristband_required_for_checkin/_for_kit isoladamente, sempre em conjunto
// com wristband_enabled (nunca confia em flag dependente true por dado
// legado quando enabled=false).
test('cenario 1/7: gates de check-in e entrega SEMPRE exigem wristband_enabled junto com o required_for_X (nunca so a flag dependente)', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  for (const [name, flag] of [
    ['checkin_ticket_entry', 'wristband_required_for_checkin'],
    ['deliver_ticket_kit_item', 'wristband_required_for_kit'],
    ['deliver_ticket_full_kit', 'wristband_required_for_kit'],
  ]) {
    const fn = extractFunction(sql, name);
    assert.match(
      fn,
      new RegExp(`if coalesce\\(v_event\\.wristband_enabled, false\\) and coalesce\\(v_event\\.${flag}, false\\) then`),
      `${name} precisa exigir wristband_enabled E ${flag} juntos`,
    );
  }
});

// Cenario 7, na FONTE da inconsistencia: a RPC que ESCREVE a configuracao
// nunca deixa required_for_checkin/required_for_kit=true quando enabled=false,
// mesmo que o chamador peca -- normaliza antes de gravar, reforcando a regra
// tambem na escrita (nao so na leitura das RPCs operacionais).
test('cenario 7: set_event_wristband_settings normaliza required_for_checkin/kit para false quando enabled=false', async () => {
  const sql = await readFile(wristbandSettingsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_event_wristband_settings');
  assert.match(fn, /v_required_for_checkin := v_enabled and coalesce\(p_required_for_checkin, false\);/);
  assert.match(fn, /v_required_for_kit := v_enabled and coalesce\(p_required_for_kit, false\);/);
});

// Cenario 2: evento usa pulseira mas nao exige em nada -- link/unlink/replace
// continuam disponiveis (so exigem wristband_enabled, nunca os required_for_*),
// e nenhuma das 3 RPCs operacionais bloqueia quando os required_for_* sao
// false (coberto pelo teste acima: o "and" so vira bloqueio quando AMBOS
// os lados sao true).
test('cenario 2: link_wristband_to_ticket exige so wristband_enabled, nunca os required_for_* (pulseira pode ser vinculada manualmente mesmo sem exigencia)', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'link_wristband_to_ticket');
  assert.match(fn, /if not coalesce\(v_event\.wristband_enabled, false\) then/);
  assert.doesNotMatch(fn, /wristband_required_for/);
});

// Cenario 5: a entrega ISOLADA de um item (deliver_ticket_kit_item, usada
// tanto pelo botao "Entregar item" quanto internamente por
// deliver_ticket_full_kit) tem o MESMO gate de pulseira que a entrega
// completa -- corrigido nesta rodada no lado do FRONTEND (o backend ja
// exigia desde a rodada anterior).
test('cenario 5: deliver_ticket_kit_item (entrega isolada) tem o mesmo gate WRISTBAND_REQUIRED que deliver_ticket_full_kit', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_ticket_kit_item');
  assert.match(fn, /message = 'WRISTBAND_REQUIRED'/);
  assert.match(fn, /perform public\.link_wristband_to_ticket\(v_ticket\.id, p_wristband_code\);/);
});

test('cenario 5 (frontend): botao "Entregar item" isolado abre o MESMO WristbandCodeModal ja usado pelos outros 3 botoes, nunca um modal/logica duplicada', async () => {
  const source = await readFile(expandedDetailsUrl, 'utf8');

  // Import unico do modal -- nao existe um segundo componente de pulseira.
  const wristbandModalImports = source.match(/import \{ WristbandCodeModal \}/g) ?? [];
  assert.equal(wristbandModalImports.length, 1, 'WristbandCodeModal deve ser importado uma unica vez (reuso, nao duplicacao)');

  // O clique no botao "Entregar item" passa pelo handler dedicado, que
  // detecta WRISTBAND_REQUIRED e abre o modo "mandatory-item".
  assert.match(source, /onClick=\{\(\) => void handleDeliverItemClick\(kitItem\.kit_item_id\)\}/);
  assert.match(source, /async function handleDeliverItemClick\(kitItemId: string\) \{/);
  assert.match(source, /setWristbandModal\("mandatory-item"\);/);

  // O modal renderizado pro modo "mandatory-item" e o MESMO componente
  // WristbandCodeModal que atende check-in/entrega completa/combinada --
  // um unico bloco JSX cobre todos os 4 modos.
  const mandatoryBlockMatch = source.match(/\{wristbandModal === "mandatory-checkin"[\s\S]*?<WristbandCodeModal[\s\S]*?\/>\s*\)\s*: null\}/);
  assert.ok(mandatoryBlockMatch, 'bloco unico do modal obrigatorio nao encontrado');
  assert.match(mandatoryBlockMatch[0], /wristbandModal === "mandatory-item"/);

  // Reenvia a operacao ORIGINAL (so aquele item, nunca o kit inteiro) com o
  // codigo informado.
  assert.match(source, /await onDeliverKitItem\(detail\.ticket_id, detail\.participant_id, pendingKitItemId, code\)/);
});

test('cenario 5 (actions.ts): deliverKitItemAction repassa wristband_code pra deliver_ticket_kit_item e traduz WRISTBAND_REQUIRED via operationRpcError', async () => {
  const source = await readFile(actionsUrl, 'utf8');
  const fn = source.match(/export async function deliverKitItemAction\([\s\S]*?\n\}/);
  assert.ok(fn, 'deliverKitItemAction nao encontrada');
  assert.match(fn[0], /p_wristband_code: payload\.wristband_code\?\.trim\(\) \|\| null,/);
  assert.match(fn[0], /\.\.\.operationRpcError\(error\)/);
});

// Cenario 6: Entregar + check-in pede a pulseira uma unica vez (mesmo
// codigo repassado pras duas sub-chamadas) e continua atomico -- ja coberto
// em detalhe no arquivo anterior (tests/operations-wristband-and-undo.test.mjs);
// aqui so confirmamos que o wiring do frontend usa o MESMO modal/handler
// pattern que os demais, sem uma segunda implementacao.
test('cenario 6: handleCombinedConfirmed (chamado apos a confirmacao obrigatoria) usa o mesmo padrao WRISTBAND_REQUIRED -> modal -> reenvio com codigo', async () => {
  const source = await readFile(expandedDetailsUrl, 'utf8');
  assert.match(source, /async function handleCombinedConfirmed\(\) \{/);
  assert.match(source, /setWristbandModal\("mandatory-combined"\);/);
  assert.match(source, /await onDeliverKitAndCheckin\(detail\.ticket_id, detail\.participant_id, code\)/);
});

// Cenario 8: pulseira ja ativa no ticket -> nenhuma das 3 RPCs pede de novo
// (v_has_wristband bloqueia a exigencia antes de levantar WRISTBAND_REQUIRED).
test('cenario 8: pulseira ja ativa nunca dispara WRISTBAND_REQUIRED de novo (checa participant_wristbands antes de exigir)', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  for (const name of ['checkin_ticket_entry', 'deliver_ticket_kit_item', 'deliver_ticket_full_kit']) {
    const fn = extractFunction(sql, name);
    assert.match(fn, /select exists\(select 1 from public\.participant_wristbands pw where pw\.ticket_id = v_ticket\.id and pw\.status = 'active'\) into v_has_wristband;/);
    assert.match(fn, /if not v_has_wristband then/);
  }
});

// Cenario 9: codigo de pulseira ja usado por OUTRO ingresso e rejeitado
// (unicidade por evento, so pulseira ativa) -- regra ja existente, nao
// alterada nesta rodada, confirmada aqui pra fechar a cobertura pedida.
test('cenario 9: link_wristband_to_ticket rejeita codigo ja ativo em outro ingresso', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'link_wristband_to_ticket');
  assert.match(fn, /and lower\(pw\.code\) = lower\(v_code\)\s*\n\s*and pw\.status = 'active'/);
  assert.match(fn, /raise exception 'Pulseira ja vinculada a outro ingresso\.';/);
  // Mesmo ticket + mesmo codigo = idempotente (nao e um erro).
  assert.match(fn, /if v_existing\.ticket_id = p_ticket_id then/);
});

// Cenario 10: nenhuma etapa de deliver_items_and_checkin roda dentro de um
// bloco que engoliria excecao -- qualquer falha (estoque, pulseira,
// check-in) aborta a chamada inteira e desfaz tudo (mesma transacao
// Postgres). Ja coberto no arquivo anterior; reconfirmado aqui como parte
// explicita dos 10 cenarios pedidos nesta rodada.
test('cenario 10: deliver_items_and_checkin nunca deixa a operacao parcialmente concluida (sem bloco de excecao interno)', async () => {
  const sql = await readFile(wristbandOpsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_items_and_checkin');
  assert.doesNotMatch(fn, /exception\s+when/i);
});

// Objetivo 2: a action de salvar configuracao reusa a RPC (nenhum client
// direto tocando a tabela events, nenhuma segunda estrutura).
test('objetivo 1/2: updateEventWristbandSettingsAction chama set_event_wristband_settings (nunca escreve em events diretamente) e revalida a pagina do evento', async () => {
  const source = await readFile(eventosActionsUrl, 'utf8');
  const startIndex = source.indexOf('export async function updateEventWristbandSettingsAction');
  assert.ok(startIndex >= 0, 'updateEventWristbandSettingsAction nao encontrada em src/app/eventos/actions.ts');
  const nextFnIndex = source.indexOf('\nexport async function', startIndex + 1);
  const body = source.slice(startIndex, nextFnIndex > -1 ? nextFnIndex : undefined);
  assert.match(body, /supabase\.rpc\("set_event_wristband_settings"/);
  assert.doesNotMatch(body, /\.from\("events"\)\.update/);
  assert.match(body, /revalidatePath\(`\/painel\/eventos\/\$\{payload\.eventId\}`\);/);
});

test('objetivo 2: set_event_wristband_settings valida autenticacao, permissao events.edit, acesso a organizacao, e audita a alteracao', async () => {
  const sql = await readFile(wristbandSettingsMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_event_wristband_settings');
  assert.match(fn, /if v_actor is null or not public\.current_user_has_permission\('events\.edit'\) then/);
  assert.match(fn, /if not public\.user_can_access_organization\(v_actor, v_event\.organization_id\) then/);
  assert.match(fn, /insert into public\.audit_logs\(action, entity_type, entity_id, event_id, details\)/);
  assert.match(fn, /'event_wristband_settings_updated'/);
  assert.match(fn, /where id = p_event_id;/);
});

test('objetivo 1: EventWristbandSettings usa os 3 campos reais do schema (wristband_enabled/wristband_required_for_checkin/wristband_required_for_kit), nunca campos novos', async () => {
  const source = await readFile(wristbandSettingsUiUrl, 'utf8');
  assert.match(source, /enabled: boolean;/);
  assert.match(source, /requiredForCheckin: boolean;/);
  assert.match(source, /requiredForKit: boolean;/);
  // UI esconde as exigencias dependentes quando desativado (nunca so
  // desabilita mantendo visivel um estado que o backend rejeitaria).
  assert.match(source, /\{draft\.enabled \? \(/);
});

test('objetivo 1: a configuracao de pulseiras esta montada na pagina real de edicao do evento (nunca orfa), lendo os 3 campos reais de public.events', async () => {
  const source = await readFile(eventDetailPageUrl, 'utf8');
  assert.match(source, /import \{ EventWristbandSettings \} from "\.\/wristband-settings";/);
  assert.match(source, /<EventWristbandSettings/);
  assert.match(source, /wristband_enabled, wristband_required_for_checkin, wristband_required_for_kit/);
});
