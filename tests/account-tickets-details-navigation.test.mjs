import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const list = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const detail = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const cadastro = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');

test('Meus ingressos usa Ver detalhes e navega para o ticket correto', () => {
  assert.doesNotMatch(list, /Ver QR Code/);
  assert.match(list, /href={`\/minha-conta\/ingressos\/\$\{item\.ticketId\}`}[\s\S]*?Ver detalhes/);
});

test('detalhe preserva QR e troca de tamanho no fluxo canonico', () => {
  assert.match(detail, /participantShirtChangeEnabled \? <ParticipantShirtChangeAction/);
  assert.match(detail, /currentLabel={`\$\{shirtType\} — \$\{shirtSize\}`}/);
  assert.match(detail, /requestTicketItemChangeAction|ParticipantShirtChangeAction/);
  assert.match(detail, /<TicketViewer/);
});

test('Ficha Global: exclusao de item adicional continua exclusiva do Owner; cancelamento de ingresso segue orders.cancel', () => {
  // Item adicional (produto da loja) permanece Owner-only -- nao fazia parte
  // da auditoria de autorizacao de ingresso e a RPC (owner_cancel_store_order_item)
  // nao foi alterada.
  assert.match(cadastro, /isOrganizationOwner \? <OwnerCancelAdditionalItemButton/);
  // Ingresso: o botao agora aparece pra Owner OU quem tem orders.cancel
  // (canCancelTickets), inclusive em ingressos ja cancelados (permite
  // reclassificar a intencao do cancelamento) -- ver auditoria em
  // 20260924000000_ticket_cancellation_replacement_intent.sql.
  assert.match(cadastro, /const canCancelTickets = isOrganizationOwner \|\| canCancelTicketByPermission;/);
  assert.match(cadastro, /\{canCancelTickets \? <OwnerCancelTicketButton/);
  assert.doesNotMatch(cadastro, /ticket\.status !== "cancelled" \? <OwnerCancelTicketButton/);
  assert.match(actions, /rpc\("owner_cancel_ticket"/);
  assert.match(actions, /rpc\("owner_cancel_store_order_item"/);
  assert.doesNotMatch(actions, /hasPermission\("store\.manage"\)[\s\S]{0,300}owner_cancel_/);
});
