import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/20260815004500_close_phase2_lint_blockers.sql', import.meta.url), 'utf8');
const fn = (name) => sql.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?end; \\$\\$;`))?.[0] ?? '';

test('pagamento usa payments orders order_items tickets e nao orders.updated_at', () => {
  const body = fn('admin_update_payment_status');
  assert.match(body, /update public\.payments/);
  assert.match(body, /update public\.orders/);
  assert.match(body, /update public\.order_items/);
  assert.match(body, /payment_status_changed/);
  assert.doesNotMatch(body, /update public\.orders[\s\S]{0,350}updated_at/);
  assert.doesNotMatch(body, /update public\.participants/);
});

test('atribuicao usa ownership do order_item e contato global', () => {
  const body = fn('assign_order_item_participant');
  assert.match(body, /registration_contact_id=v_contact\.id/);
  assert.match(body, /ownership_status='assigned'/);
  assert.match(body, /update public\.tickets set participant_id/);
  assert.doesNotMatch(body, /tickets[\s\S]*ownership_status/);
});

test('emissao manual e contact-first e camiseta pertence ao order_item', () => {
  const body = fn('create_manual_registration_order');
  assert.match(body, /resolve_import_registration_contact/);
  assert.match(body, /insert into public\.order_items[\s\S]*shirt_type,shirt_size/);
  assert.match(body, /ensure_ticket_kit_items\(v_ticket\)/);
  const projectionInsert = body.match(/insert into public\.participants\([\s\S]*?returning \* into v_participant/)?.[0] ?? '';
  assert.doesNotMatch(projectionInsert, /shirt_type|shirt_size|ticket_category_id|batch_id/);
  assert.match(body, /v_type text:=/);
});

test('cupom atualiza apenas entidades comerciais canonicas', () => {
  const body = fn('redeem_coupon');
  assert.match(body, /coupon_redemptions/);
  assert.match(body, /update public\.payments/);
  assert.match(body, /update public\.orders/);
  assert.match(body, /update public\.order_items/);
  assert.doesNotMatch(body, /update public\.participants/);
  assert.match(body, /COUPON_PAYMENT_CONTEXT_AMBIGUOUS/);
});

test('check-in e ticket-first e loyalty ausente nao bloqueia', () => {
  const body = fn('checkin_ticket_entry');
  assert.match(body, /update public\.tickets set status='used'/);
  assert.match(body, /participation_history/);
  assert.doesNotMatch(body, /recalculate_customer_loyalty/);
  const legacy = fn('checkin_participant_entry');
  assert.match(legacy, /resolve_unique_ticket_for_participant/);
  assert.match(legacy, /checkin_ticket_entry/);
});

test('entrega combinada tem retorno tipado e delega para RPCs ticket-first', () => {
  const body = fn('deliver_kit_and_checkin');
  assert.match(body, /returns table\(success boolean,kit_delivered boolean,checkin_done boolean,message text,participant_id uuid,event_id uuid\)/);
  assert.match(body, /deliver_ticket_full_kit\(v_ticket\.id\)/);
  assert.match(body, /checkin_ticket_entry\(v_ticket\.id\)/);
  assert.match(sql, /revoke all on function public\.deliver_kit_and_checkin\(uuid\) from authenticated/);
});

test('migration nao introduz escritor canonico em participants', () => {
  assert.doesNotMatch(sql, /update public\.participants[\s\S]{0,300}(payment|shirt|category|batch|registration_status)/);
});
