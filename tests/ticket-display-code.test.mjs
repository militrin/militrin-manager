import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('nomenclatura: PIN da conta, PIN do cadastro e Codigo do ingresso nao se misturam', async () => {
  const [pinCopy, dados, cadastro, emit, expanded, holderUi] = await Promise.all([
    read('../src/app/minha-conta/public-pin-copy.tsx'),
    read('../src/app/minha-conta/dados/page.tsx'),
    read('../src/app/cadastros/[id]/page.tsx'),
    read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../src/app/operacoes/components/ExpandedTicketDetails.tsx'),
    read('../src/app/minha-conta/ingressos/[ticketId]/ticket-holder-actions.tsx'),
  ]);
  assert.match(pinCopy, /PIN da conta/);
  assert.doesNotMatch(pinCopy, /Código do ingresso/);
  assert.match(dados, /PIN da conta/);
  assert.doesNotMatch(dados, /Código do ingresso/);
  assert.match(cadastro, /PIN do cadastro/);
  assert.match(emit, /PIN do cadastro/);
  assert.match(expanded, /PIN do cadastro/);
  assert.match(expanded, /Código do ingresso/);
  assert.doesNotMatch(holderUi, /Código do ingresso/);
  assert.doesNotMatch(holderUi, /PIN da conta/);
});

test('Minha Conta e passe mostram o codigo canônico do ingresso', async () => {
  const [list, ficha, card, pass, format, home] = await Promise.all([
    read('../src/app/minha-conta/ingressos/page.tsx'),
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/components/militrin/MilitrinTicketCard.tsx'),
    read('../src/components/ticket-pass/TicketHolderInfo.tsx'),
    read('../src/components/ticket-pass/ticket-pass-format.ts'),
    read('../src/app/minha-conta/home-ticket-carousel.tsx'),
  ]);
  assert.match(list, /canonicalTicketDisplayCode\(/);
  assert.match(list, /ticketCode=\{item\.ticketCode\}/);
  assert.match(ficha, /canonicalTicketDisplayCode\(/);
  assert.match(ficha, /CopyableId label="Código do ingresso"/);
  assert.match(ficha, /ticketCode=\{ticketCode\}/);
  assert.match(card, /Código do ingresso/);
  assert.match(pass, /TICKET_PASS_COPY\.ticketCodeLabel/);
  assert.match(format, /ticketCodeLabel: 'Código do ingresso'/);
  assert.match(home, /Código do ingresso \{current\.ticketCode\}/);
});

test('admin ficha nao usa 8 caracteres do QR como referencia humana', async () => {
  const [adminFicha, editorPage, editor] = await Promise.all([
    read('../src/app/ingressos/[ticketId]/page.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/page.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),
  ]);
  assert.doesNotMatch(adminFicha, /slice\(0,\s*8\)/);
  assert.doesNotMatch(editorPage, /slice\(0,\s*8\)/);
  assert.match(adminFicha, /canonicalTicketDisplayCode\(/);
  assert.match(adminFicha, /CopyableId label="Código do ingresso"/);
  assert.match(editorPage, /canonicalTicketDisplayCode\(/);
  assert.match(editor, /Código do ingresso:/);
  assert.match(editor, /Evento:/);
  assert.match(editor, /Titular:/);
  assert.match(editor, /Nova conta:/);
  assert.match(editor, /Confirmar transferência/);
  assert.match(editor, /admin_transfer_ticket_ownership|transferTicketOwnershipAction/);
});

test('busca admin e Central aceitam codigo completo sem ambiguidade', async () => {
  const [migration, filters, turbo, actions, page] = await Promise.all([
    read('../supabase/migrations/20261029000000_canonical_ticket_display_code.sql'),
    read('../src/app/operacoes/components/OperationsFilters.tsx'),
    read('../src/app/operacoes/components/TurboMode.tsx'),
    read('../src/app/operacoes/actions.ts'),
    read('../src/app/operacoes/page.tsx'),
  ]);
  assert.match(migration, /v_code_display is not null/);
  assert.match(migration, /f\.display_number = v_code_display/);
  assert.match(migration, /f\.item_position = v_code_position/);
  assert.match(migration, /TICKET_DISPLAY_CODE_BACKFILL_BLOCKED/);
  assert.match(migration, /item_position = 1/);
  assert.match(migration, /before insert or update on public.order_items/);
  assert.match(migration, /TICKET_ITEM_POSITION_IMMUTABLE/);
  assert.match(migration, /TICKET_ITEM_POSITION_REQUIRED/);
  assert.match(migration, /ORDER_DISPLAY_NUMBER_IMMUTABLE/);
  assert.match(migration, /before update on public.orders/);
  assert.doesNotMatch(migration, /public_ticket_id/);
  assert.match(filters, /código do ingresso/);
  assert.match(turbo, /código do ingresso/);
  assert.match(actions, /matchesTicketOperationSearch/);
  assert.match(actions, /ticket_display_code/);
  assert.match(page, /ticketMatchesExactDisplayCode/);
});

test('titular, propriedade, check-in e kit nao reescrevem o codigo do ingresso', async () => {
  const [holder, latest, ops] = await Promise.all([
    read('../supabase/migrations/20261028000000_ticket_holder_textual_name.sql'),
    read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
    read('../src/app/operacoes/actions.ts'),
  ]);
  const holderFn = holder.split('create or replace function public.apply_ticket_holder_name_internal')[1]?.split('create or replace function')[0] ?? '';
  assert.match(holderFn, /holder_full_name/);
  assert.doesNotMatch(holderFn, /item_position\s*=/);
  assert.doesNotMatch(holderFn, /display_number\s*=/);
  assert.match(latest, /admin_transfer_ticket_ownership/);
  assert.doesNotMatch(latest, /item_position/);
  assert.match(ops, /deliver_ticket_full_kit/);
  assert.match(ops, /checkin_ticket_entry/);
});
