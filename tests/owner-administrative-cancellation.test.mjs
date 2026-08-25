import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20260891000000_owner_cancel_contact_items_and_tickets.sql', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const ui = await readFile(new URL('../src/app/cadastros/administrative-delete-actions.tsx', import.meta.url), 'utf8');

function fn(name) { const start=migration.indexOf(`create or replace function public.${name}`); const end=migration.indexOf('$$;',start); return migration.slice(start,end+3); }

test('botoes e actions sao exclusivos do Owner nas tres camadas',()=>{
  assert.match(page,/isOrganizationOwner \? <OwnerCancelAdditionalItemButton/); assert.match(page,/isOrganizationOwner && ticket\.status !== "cancelled" \? <OwnerCancelTicketButton/);
  assert.match(actions,/assertCurrentOrganizationOwner/); assert.match(migration,/is_organization_owner\(v_actor,v_ticket\.organization_id\)/); assert.match(migration,/is_organization_owner\(v_actor,v_order\.organization_id\)/);
  assert.match(fn('admin_cancel_ticket'),/owner_cancel_ticket\(p_ticket_id,'administrative_correction',p_reason\)/);
});

test('ticket bloqueia check-in e entrega, cancela logicamente e preserva cadeia comercial',()=>{
  const sql=fn('owner_cancel_ticket'); assert.match(sql,/v_ticket\.status='used' or v_ticket\.used_at is not null/); assert.match(sql,/kit_link\.status='delivered'/);
  assert.match(sql,/set status='cancelled'/); assert.doesNotMatch(sql,/delete from/); assert.doesNotMatch(sql,/update public\.(orders|order_items)/);
});

test('cancelamento do ticket usa reconciliacao deterministica e nunca subtracao aritmetica',()=>{
  const sql=fn('owner_cancel_ticket'); assert.match(sql,/update public\.participant_kit_items[\s\S]*set status='cancelled'/); assert.match(sql,/update public\.tickets[\s\S]*set status='cancelled'/);
  assert.doesNotMatch(sql,/reserved_quantity\s*=\s*(greatest\()?reserved_quantity\s*-/); assert.doesNotMatch(sql,/total_quantity|delivered_quantity/);
});

test('repeticao e idempotente e ticket cancelado sai da fonte de demanda',()=>{
  assert.match(fn('owner_cancel_ticket'),/status='cancelled'[\s\S]*'changed',false/);
  assert.match(migration,/audit_logs[\s\S]*admin_ticket_cancelled/);
});

test('item entregue e cobranca paga bloqueiam; cortesia e cancelada logicamente',()=>{
  const sql=fn('owner_cancel_store_order_item'); assert.match(sql,/v_line\.status='delivered' or v_line\.delivered_at is not null/); assert.match(sql,/payment_status='paid' and v_order\.payment_method<>'admin_courtesy'/);
  assert.doesNotMatch(sql,/delete from/); assert.match(sql,/set status='cancelled'/);
});

test('item compartilhado reconcilia por status e estoque proprio usa roteador existente',()=>{
  const sql=fn('owner_cancel_store_order_item'); assert.match(sql,/linked_event_kit_item_id is null[\s\S]*release_store_item_reservation/); assert.match(sql,/update public\.store_order_items[\s\S]*set status='cancelled'/);
  assert.doesNotMatch(sql,/update public\.event_kit_item_variant_inventory/);
});

test('motivo obrigatorio, outro detalhado e auditoria completa',()=>{
  assert.match(ui,/reasonCode === "other"/); assert.match(actions,/ADMIN_DELETE_REASONS/); assert.match(migration,/reason_code[\s\S]*reason_text[\s\S]*actor_user_id[\s\S]*cancelled_at/);
});
