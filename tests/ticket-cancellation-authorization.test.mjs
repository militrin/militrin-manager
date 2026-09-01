import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260924000000_ticket_cancellation_replacement_intent.sql', import.meta.url), 'utf8');
const cadastrosActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const cadastroPage = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const editarPage = await readFile(new URL('../src/app/ingressos/[ticketId]/editar/page.tsx', import.meta.url), 'utf8');
const editarActions = await readFile(new URL('../src/app/ingressos/[ticketId]/editar/actions.ts', import.meta.url), 'utf8');
const permissions = await readFile(new URL('../src/lib/admin/permissions.ts', import.meta.url), 'utf8');

const ownerCancel = migration.slice(
  migration.indexOf('create or replace function public.owner_cancel_ticket'),
  migration.indexOf('create or replace function public.admin_cancel_ticket'),
);

// Auditoria pre-push encontrou: /ingressos/[ticketId]/editar ja usava
// assertPermission('orders.cancel') (concedivel a admins/moderadores, nao
// so Owner), mas owner_cancel_ticket exigia is_organization_owner --
// "frontend permite, RPC rejeita". admin_permissions confirma que
// orders.cancel foi desenhada de proposito pra isso (modulo 'orders',
// descricao "Cancela pedidos", ao lado de orders.edit/orders.view). Corrigido
// pra usar o MESMO idioma ja dominante no resto do sistema (ver
// resolve_ticket_data_issues, resolve_import_ticket_options,
// update_participant_event_notes): user_can_access_organization(actor,org)
// AND (is_active_owner(actor) OR resolve_user_permission(actor,'<codigo>')).

test('owner_cancel_ticket usa o idioma padrao do sistema: org-scope + (Owner administrativo OU orders.cancel)', () => {
  assert.match(ownerCancel, /if not \(public\.user_can_access_organization\(v_actor,v_ticket\.organization_id\)\s*\n\s*and \(public\.is_active_owner\(v_actor\) or public\.resolve_user_permission\(v_actor,'orders\.cancel'\)\)\)/);
  assert.doesNotMatch(ownerCancel, /is_organization_owner/);
});

test('mensagem de erro deixa de mencionar "Owner" exclusivamente (a acao nao e mais Owner-only)', () => {
  assert.doesNotMatch(ownerCancel, /Somente o Owner/i);
  assert.match(ownerCancel, /Sem permissao para cancelar ingresso/);
});

test('cancelamento de ingresso (Server Action) usa autorizacao org+orders.cancel, distinta do Owner-only de item adicional', () => {
  const ticketAction = cadastrosActions.slice(cadastrosActions.indexOf('export async function cancelCadastroTicketAction'), cadastrosActions.indexOf('export async function cancelCadastroAdditionalItemAction'));
  const itemAction = cadastrosActions.slice(cadastrosActions.indexOf('export async function cancelCadastroAdditionalItemAction'));
  assert.match(ticketAction, /assertCanCancelTicket/);
  assert.doesNotMatch(ticketAction, /assertCurrentOrganizationOwner/);
  assert.match(itemAction, /assertCurrentOrganizationOwner/);
  assert.match(cadastrosActions, /async function assertCanCancelTicket\(\)[\s\S]*?context\.isOrgOwner[\s\S]*?hasPermission\("orders\.cancel"\)/);
});

test('ficha do cadastro calcula canCancelTickets a partir de Owner OU orders.cancel (nao mais Owner-only)', () => {
  assert.match(cadastroPage, /hasPermission\("orders\.cancel"\)/);
  assert.match(cadastroPage, /const canCancelTickets = isOrganizationOwner \|\| canCancelTicketByPermission;/);
  assert.doesNotMatch(cadastroPage, /isOrganizationOwner \? <OwnerCancelTicketButton/);
});

test('segunda tela de cancelamento (/ingressos/[ticketId]/editar) ja usava orders.cancel e continua consistente com a RPC corrigida', () => {
  assert.match(editarPage, /"orders\.cancel"/);
  assert.match(editarActions, /assertPermission\("orders\.cancel"\)/);
});

test('item adicional (loja) nao foi tocado por esta auditoria: continua exigindo Owner na propria RPC', () => {
  // Esta migration so MENCIONA owner_cancel_store_order_item em comentario
  // (pra registrar que ficou fora do escopo) -- nunca a redefine.
  assert.doesNotMatch(migration, /create or replace function public\.owner_cancel_store_order_item/);
});

test('autorizacao continua escopada a organizacao (nunca liberada genericamente pra "authenticated")', () => {
  assert.match(ownerCancel, /user_can_access_organization\(v_actor,v_ticket\.organization_id\)/);
  assert.match(migration, /revoke all on function public\.owner_cancel_ticket\(uuid,text,text,boolean\) from public,anon;/);
  assert.match(migration, /grant execute on function public\.owner_cancel_ticket\(uuid,text,text,boolean\) to authenticated,service_role;/);
});

test('hasPermission/assertPermission (camada TS) resolvem via current_user_has_permission -- mesma fonte que resolve_user_permission no banco', () => {
  assert.match(permissions, /current_user_has_permission/);
});
