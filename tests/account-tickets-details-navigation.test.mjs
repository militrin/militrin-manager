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

test('Ficha Global mostra exclusoes somente ao Owner e actions usam RPCs Owner-only', () => {
  assert.match(cadastro, /isOrganizationOwner \? <OwnerCancelAdditionalItemButton/);
  assert.match(cadastro, /isOrganizationOwner && ticket\.status !== "cancelled" \? <OwnerCancelTicketButton/);
  assert.match(actions, /rpc\("owner_cancel_ticket"/);
  assert.match(actions, /rpc\("owner_cancel_store_order_item"/);
  assert.doesNotMatch(actions, /hasPermission\("store\.manage"\)[\s\S]{0,300}owner_cancel_/);
});
