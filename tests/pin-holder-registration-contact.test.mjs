import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ownership-only keep nao altera holder nem registration_contact_id', async () => {
  const sql = await read('supabase/legacy_migrations_backup/139_ticket_current_ownership.sql');
  const fn = sql.slice(
    sql.indexOf('create or replace function public.admin_transfer_ticket_ownership'),
    sql.indexOf('revoke all on function public.admin_transfer_ticket_ownership'),
  );
  assert.match(fn, /p_holder_action not in\('keep','assign_new_owner','remove'\)/);
  const keepPath = fn.slice(0, fn.indexOf("if p_holder_action='assign_new_owner'"));
  assert.doesNotMatch(keepPath, /admin_set_ticket_holder_contact/);
  assert.doesNotMatch(keepPath, /update public\.order_items/);
  assert.doesNotMatch(fn, /update public\.payments/);
  assert.match(fn, /update public\.tickets set owner_user_id=p_new_owner_user_id/);
  assert.doesNotMatch(fn, /change_ticket_holder_by_pin_internal/);
});

test('PIN holder change atualiza participant, holder e registration_contact_id; preserva QR e buyer', async () => {
  const sql = await read('supabase/migrations/20261026000000_operational_integrity_holder_store_finance.sql');
  const start = sql.indexOf('create or replace function public.change_ticket_holder_by_pin_internal');
  const end = sql.indexOf('comment on function public.change_ticket_holder_by_pin_internal');
  const fn = sql.slice(start, end);

  assert.match(fn, /registration_contact_id = coalesce\(v_canonical_contact_id, registration_contact_id\)/);
  assert.match(fn, /participant_id = v_target_participant\.id/);
  assert.match(fn, /holder_full_name = v_target\.full_name/);
  assert.match(fn, /v_canonical_contact_id := coalesce\(v_target_contact_id, v_target_participant\.registration_contact_id\)/);
  assert.match(fn, /update public\.tickets set participant_id = v_target_participant\.id where id = v_ticket\.id/);
  assert.doesNotMatch(fn, /update public\.tickets set[\s\S]*token/);
  assert.doesNotMatch(fn, /owner_user_id\s*=/);
  assert.doesNotMatch(fn, /update public\.orders /);
  assert.doesNotMatch(fn, /update public\.payments/);
  assert.match(fn, /Nao altera token\/QR, owner_user_id, pedido, comprador ou pagamentos/);
});

test('detector de titularidade nao rotula registration_contact_id como titular atual', async () => {
  const sql = await read('supabase/migrations/20261026000000_operational_integrity_holder_store_finance.sql');
  const start = sql.indexOf('create or replace function public.detect_integrity_legacy_holder_mismatch');
  const end = sql.indexOf('revoke all on function public.detect_integrity_legacy_holder_mismatch');
  const fn = sql.slice(start, end);

  assert.match(fn, /Referência cadastral do item desatualizada/);
  assert.match(fn, /referência cadastral histórica do item ainda aponta para outro cadastro/);
  assert.match(fn, /operational_holder_name/);
  assert.match(fn, /residual_contact_name/);
  assert.match(fn, /owner_user_id/);
  assert.match(fn, /buyer_user_id/);
  assert.doesNotMatch(fn, /'current_holder_name'/);
  assert.match(fn, /oi\.registration_contact_id is distinct from p\.registration_contact_id/);
});
