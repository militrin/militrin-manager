import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const wrapperFixUrl = new URL('../supabase/migrations/20260850000000_fix_participant_undo_kit_wrappers.sql', import.meta.url);
const undoOpsMigrationUrl = new URL('../supabase/migrations/20260848000000_wristband_requirement_and_reason_coded_undo.sql', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// Bug real reportado por `supabase db lint --linked` depois de aplicar
// 47/48/49 no remoto: os wrappers participant-first ficaram chamando uma
// assinatura de undo_ticket_kit_item/undo_ticket_full_kit que nao existe
// mais (a 20260848000000 tornou o motivo obrigatorio, mudando a
// assinatura). Este teste trava a sincronia entre os dois lados pra esse
// tipo de regressao nunca mais passar despercebido.
test('undo_participant_kit_item/undo_participant_full_kit chamam a assinatura ATUAL (com motivo obrigatorio) das funcoes ticket-first', async () => {
  const wrapperSql = await readFile(wrapperFixUrl, 'utf8');

  const kitItemWrapper = extractFunction(wrapperSql, 'undo_participant_kit_item');
  assert.match(kitItemWrapper, /p_participant_id uuid, p_kit_item_id uuid, p_reason_code text, p_reason_text text default null/);
  assert.match(
    kitItemWrapper,
    /return public\.undo_ticket_kit_item\(public\.resolve_unique_ticket_for_participant\(p_participant_id\), p_kit_item_id, p_reason_code, p_reason_text\);/,
  );

  const fullKitWrapper = extractFunction(wrapperSql, 'undo_participant_full_kit');
  assert.match(fullKitWrapper, /p_participant_id uuid, p_reason_code text, p_reason_text text default null/);
  assert.match(
    fullKitWrapper,
    /return public\.undo_ticket_full_kit\(public\.resolve_unique_ticket_for_participant\(p_participant_id\), p_reason_code, p_reason_text\);/,
  );
});

test('drop explicito das assinaturas antigas dos 2 wrappers (Postgres nao substitui overload por CREATE OR REPLACE)', async () => {
  const sql = await readFile(wrapperFixUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.undo_participant_kit_item\(uuid, uuid\);/);
  assert.match(sql, /drop function if exists public\.undo_participant_full_kit\(uuid\);/);
});

// A regra "motivo sempre obrigatorio" (sem default em p_reason_code) e
// preservada tambem no caminho legado -- nunca virou opcional pra
// "destravar" o wrapper.
test('p_reason_code continua OBRIGATORIO (sem default) nos dois wrappers -- a regra de motivo nunca foi enfraquecida', async () => {
  const sql = await readFile(wrapperFixUrl, 'utf8');
  assert.doesNotMatch(sql, /p_reason_code text default/);
});

// Grants preservados exatamente como estavam antes (service_role apenas) --
// a correcao nao amplia quem pode chamar esses wrappers.
test('grants dos wrappers permanecem restritos a service_role (nunca expostos a anon/authenticated)', async () => {
  const sql = await readFile(wrapperFixUrl, 'utf8');
  assert.match(sql, /revoke all on function public\.undo_participant_kit_item\(uuid, uuid, text, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.undo_participant_kit_item\(uuid, uuid, text, text\) to service_role;/);
  assert.match(sql, /revoke all on function public\.undo_participant_full_kit\(uuid, text, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.undo_participant_full_kit\(uuid, text, text\) to service_role;/);
  assert.doesNotMatch(sql, /grant execute on function public\.undo_participant_(kit_item|full_kit)\([^)]*\) to authenticated/);
});

// undo_participant_checkin fica FORA do escopo desta correcao: nunca
// delegou pra undo_ticket_checkin (tem logica propria), entao nunca foi
// quebrada pela 20260848000000 -- nao deve ser tocada aqui.
test('undo_participant_checkin nao e alterada por esta migration (fora do escopo -- nao estava quebrada)', async () => {
  const sql = await readFile(wrapperFixUrl, 'utf8');
  // So o SQL executavel (depois de "begin;") -- o cabecalho de comentarios
  // cita undo_participant_checkin de proposito, ao documentar por que ela
  // fica fora do escopo desta correcao.
  const executable = sql.slice(sql.indexOf('begin;'));
  assert.doesNotMatch(executable, /undo_participant_checkin/);
});

// Confirma, do lado ticket-first, que as assinaturas que os wrappers agora
// chamam realmente existem com esses parametros (mesma migration da rodada
// anterior, nao alterada aqui).
test('as funcoes ticket-first referenciadas pelos wrappers existem com a assinatura esperada', async () => {
  const sql = await readFile(undoOpsMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.undo_ticket_kit_item\(\s*\n\s*p_ticket_id uuid, p_kit_item_id uuid, p_reason_code text, p_reason_text text default null\s*\n\)/);
  assert.match(sql, /create or replace function public\.undo_ticket_full_kit\(\s*\n\s*p_ticket_id uuid, p_reason_code text, p_reason_text text default null\s*\n\)/);
});
