import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';
import { formatOperatorDisplayName, isUuidLike } from '../src/lib/admin/operator-display.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const UUID = 'e8f5777b-3ed1-409d-9c4a-aaaaaaaaaaaa';

test('formatOperatorDisplayName: nome, e-mail mascarado, Operador; nunca UUID cru', () => {
  assert.equal(formatOperatorDisplayName({ resolvedName: 'Douglas Hobold', actorUserId: UUID, actorEmail: 'h@x.com' }), 'Douglas Hobold');
  assert.equal(formatOperatorDisplayName({ resolvedName: UUID, actorUserId: UUID, actorEmail: 'hobold@gmail.com' }), 'ho***@gmail.com');
  assert.equal(formatOperatorDisplayName({ actorUserId: UUID }), 'Operador');
  assert.equal(formatOperatorDisplayName({}), 'Sistema');
  assert.ok(!isUuidLike(formatOperatorDisplayName({ actorUserId: UUID })));
  assert.ok(!formatOperatorDisplayName({ actorUserId: UUID, actorEmail: UUID }).includes(UUID));
});

test('auditReasonFromDetails prefere reason_text persistido e rotulo de reason_code', async () => {
  const source = await read('../src/lib/admin/audit-reason-label.ts');
  assert.match(source, /\["reason_text", "reason", "review_notes"\]/);
  assert.match(source, /REASON_CODE_LABELS/);
  assert.match(source, /sensitiveActionReasonLabel\(code\)/);
});

test('Central resolve ator da entrega/check-in via resolveOperatorNames e formatOperatorDisplayName; nunca usa actor_user_id cru', async () => {
  const source = await read('../src/app/operacoes/actions.ts');
  const start = source.indexOf('const details = latestCheckin?.details');
  const end = source.indexOf('const kitItems = ((kitRows ?? [])');
  const block = source.slice(start, end);
  assert.match(block, /resolveOperatorNames\(operatorIdsToResolve\)/);
  assert.match(block, /formatOperatorDisplayName/);
  assert.doesNotMatch(block, /actor_email \?\? auditDetails\?\.actor_user_id/);
  assert.doesNotMatch(block, /actor_email \?\? details\.actor_user_id/);
});

test('ficha administrativa resolve owner canonico e nao exibe Conta NEXORA', async () => {
  const [detail, editorPage, editor, actions, rpc, plataforma, clientes] = await Promise.all([
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/page.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
    read('../src/lib/admin/ticket-owner-rpc.ts'),
    read('../src/app/plataforma/page.tsx'),
    read('../src/app/plataforma/clientes/page.tsx'),
  ]);
  for (const source of [detail, editorPage, editor, actions, rpc, plataforma, clientes]) {
    assert.doesNotMatch(source, /NEXORA/);
  }
  assert.match(detail, /resolveLinkedAccountLabel/);
  assert.match(editorPage, /resolveLinkedAccountLabel/);
  assert.match(editor, /Conta vinculada/);
  assert.match(actions, /Nenhuma conta encontrada\./);
  assert.match(rpc, /Selecione uma conta válida\./);
});

test('timeline le reason_text/reason_code, inclui wristband_linked/unlinked e resolve operador pelo nome', async () => {
  const source = await read('../src/lib/admin/ticket-timeline.ts');
  assert.match(source, /auditReasonFromDetails\(details\)/);
  assert.match(source, /formatOperatorDisplayName/);
  assert.match(source, /details->>ticket_id/);
  assert.match(source, /wristband_linked/);
  assert.match(source, /wristband_unlinked/);
  assert.match(source, /action\.startsWith\("wristband_"\)/);
  assert.doesNotMatch(source, /state\(details, \["reason", "review_notes"\]\)/);
});

test('taxonomia da timeline ja tem pulseira vinculada/desvinculada', async () => {
  const taxonomy = await read('../src/lib/admin/ticket-event-taxonomy.ts');
  assert.match(taxonomy, /wristband_linked: \{ label: "Pulseira vinculada"/);
  assert.match(taxonomy, /wristband_unlinked: \{ label: "Pulseira desvinculada"/);
});

test('consulta de pulseira diferencia nunca vinculada, desvinculada e ativa', async () => {
  const client = await read('../src/app/operacoes/pulseira/WristbandLookupClient.tsx');
  assert.match(client, /Pulseira ainda não vinculada\./);
  assert.match(client, /Pulseira desvinculada e disponível para novo vínculo\./);
  assert.match(client, /Pulseira vinculada/);
  assert.doesNotMatch(client, /ainda não pertence a nenhum participante/);
});

test('linha compacta mostra Fazer check-in mesmo com kit pendente e abre modal obrigatorio de pulseira', async () => {
  const row = await read('../src/app/operacoes/components/OperationRow.tsx');
  assert.match(row, /\{item\.checkin_status !== "done" \? \(/);
  assert.doesNotMatch(row, /kit_status === "delivered" \|\| item\.kit_status === "none" \|\| !selectedEvent\?\.has_kit/);
  assert.match(row, /async function handleCheckinClick/);
  assert.match(row, /result\.code === "WRISTBAND_REQUIRED"/);
  assert.match(row, /setWristbandModal\("mandatory-checkin"\)/);
  assert.match(row, /onCheckin\(item\.ticket_id, code\)/);
  assert.match(row, /mandatory/);
  assert.match(row, /Pulseira obrigatória para check-in/);
});

test('RPCs homologadas do Gate #3 nao foram reescritas nesta correcao de UX', async () => {
  const actions = await read('../src/app/operacoes/actions.ts');
  assert.match(actions, /deliver_ticket_full_kit/);
  assert.match(actions, /deliver_items_and_checkin/);
  assert.match(actions, /checkin_ticket_entry/);
  assert.match(actions, /undo_ticket_full_kit/);
  assert.match(actions, /undo_ticket_checkin/);
});
