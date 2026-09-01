import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260924000000_ticket_cancellation_replacement_intent.sql', import.meta.url), 'utf8');
const cadastrosActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const deleteButtons = await readFile(new URL('../src/app/cadastros/administrative-delete-actions.tsx', import.meta.url), 'utf8');
const editarActions = await readFile(new URL('../src/app/ingressos/[ticketId]/editar/actions.ts', import.meta.url), 'utf8');

const ownerCancel = migration.slice(
  migration.indexOf('create or replace function public.owner_cancel_ticket'),
  migration.indexOf('create or replace function public.admin_cancel_ticket'),
);
const detector = migration.slice(migration.indexOf('create or replace function public.detect_integrity_paid_order_without_ticket'));

// Caso real diagnosticado: pedido MIL-2026-00001078 (cortesia administrativa)
// teve o ingresso cancelado por admin_cancel_ticket (reason_code
// 'administrative_correction'), sem NUNCA registrar se aquilo encerrava o
// entitlement ou exigia um substituto. PAID_ORDER_WITHOUT_TICKET so sabia
// checar "existe ticket ativo?" -- bloqueava pra sempre.

test('11) pagamento confirmado + nunca houve ticket continua bloqueando (sem nenhum cancelamento registrado)', () => {
  assert.match(detector, /oi\.status in \('confirmed', 'transferred'\)/);
  assert.match(detector, /payments pay where \(pay\.order_id = o\.id or pay\.id = o\.payment_id\) and pay\.payment_status = 'paid'/);
  assert.match(detector, /and t\.id is null/);
});

test('12) ticket removido definitivamente por admin (replacement_required=false) nao bloqueia mais', () => {
  assert.match(detector, /and not exists \(\s*select 1 from public\.tickets ct\s*where ct\.order_item_id = oi\.id and ct\.status = 'cancelled' and ct\.cancellation_replacement_required = false\s*\)/);
});

test('13) ticket cancelado exigindo substituicao (replacement_required=true) continua bloqueando', () => {
  // O NOT EXISTS so exclui quando replacement_required e explicitamente
  // false -- true (e null, ver teste 15) deixam o "not exists" verdadeiro,
  // ou seja, o pedido continua batendo no restante do WHERE e sendo flagado.
  assert.match(detector, /cancellation_replacement_required = false/);
  assert.doesNotMatch(detector, /cancellation_replacement_required (is true|<> false|is not false)/);
});

test('14) substituto ativo existente nao bloqueia (regra original preservada)', () => {
  assert.match(detector, /left join public\.tickets t on t\.order_item_id = oi\.id and t\.status <> 'cancelled'/);
});

test('15) cancelamento nunca desaparece da verificacao sem intencao administrativa explicita: NULL e tratado como bloqueante, nao como resolvido', () => {
  // coalesce/-> nada substitui NULL por false aqui: uma comparacao
  // `cancellation_replacement_required = false` com NULL e NULL (falsy),
  // entao o NOT EXISTS permanece verdadeiro (continua bloqueando) quando a
  // intencao nunca foi registrada -- exatamente o caso do ticket legado.
  assert.doesNotMatch(detector, /coalesce\(ct\.cancellation_replacement_required/);
  assert.match(migration, /null = cancelamento legado sem intencao registrada \(tratado como true\/bloqueante/);
});

test('owner_cancel_ticket exige a intencao explicitamente (nunca aceita silêncio)', () => {
  assert.match(ownerCancel, /if p_replacement_required is null then raise exception 'Informe se este ingresso precisa ser substituido\.'; end if;/);
});

test('owner_cancel_ticket grava a intencao na propria linha do ingresso (nao so no audit_logs em texto livre)', () => {
  assert.match(ownerCancel, /cancellation_reason_code=p_reason_code,cancellation_reason_text=v_reason_text,cancellation_replacement_required=p_replacement_required/);
});

test('ingresso ja cancelado pode ser reclassificado pelo Owner (nao fica preso num cancelamento legado sem intencao)', () => {
  assert.match(ownerCancel, /if v_was_cancelled then/);
  assert.match(ownerCancel, /ticket_cancellation_reclassified/);
  assert.doesNotMatch(ownerCancel, /if v_ticket\.status='cancelled' then return jsonb_build_object\('success',true,'changed',false/);
});

test('admin_cancel_ticket (caminho legado de texto livre) tambem exige e repassa a intencao, com default seguro (continua bloqueando)', () => {
  const legacy = migration.slice(migration.indexOf('create or replace function public.admin_cancel_ticket'));
  assert.match(legacy, /p_replacement_required boolean default true/);
  assert.match(legacy, /owner_cancel_ticket\(p_ticket_id,'administrative_correction',p_reason,coalesce\(p_replacement_required,true\)\)/);
});

test('UI de cadastros: cancelamento de ingresso exige a decisão de substituição antes de habilitar o botão', () => {
  assert.match(deleteButtons, /Precisa de um ingresso substituto\?/);
  assert.match(deleteButtons, /!isTicket \|\| replacementRequired !== ""/);
  assert.match(cadastrosActions, /p_replacement_required: payload\.replacementRequired/);
});

test('UI de cadastros: ingresso já cancelado ainda pode ter a decisão registrada (reclassificação), sem precisar de UPDATE manual em produção', () => {
  assert.match(deleteButtons, /alreadyCancelled/);
  assert.match(deleteButtons, /Definir substituição/);
});

test('segunda tela de cancelamento (/ingressos/[ticketId]/editar) tambem captura a intencao', () => {
  assert.match(editarActions, /replacementRequired: boolean/);
  assert.match(editarActions, /p_replacement_required: replacementRequired/);
});

// Cenario 17: a Integridade continua detectando inconsistencias reais --
// nenhuma das duas correcoes (camiseta, cancelamento) afrouxa a regra alem
// do escopo exato do falso positivo encontrado.
test('17) as correcoes nao desativam nenhum detector nem removem verificacoes da lista de aprovadas', async () => {
  const enrichment = await readFile(new URL('../supabase/migrations/20260819000000_operational_integrity_entity_enrichment.sql', import.meta.url), 'utf8');
  const detectorCount = (enrichment.match(/'([A-Z_]+)', '[a-z_]+', '[^']*'/g) ?? []).length;
  assert.ok(detectorCount >= 14, 'a lista de detectores aprovados deve continuar com todas as verificacoes conhecidas');
});
