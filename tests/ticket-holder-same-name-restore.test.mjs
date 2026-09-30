import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/20261117000000_restore_same_name_holder_links.sql', import.meta.url), 'utf8');

const TARGETS = [
  '8a994cbb-ef79-452a-8762-625c440c7411',
  '8f84b813-d43a-40d2-a1a4-0cdeb65038c8',
  'e87416dd-aff5-42cf-8724-ad12d4cbe8f0',
  '90784f42-3bd1-4941-a42e-8593abffefc7',
  'd8277988-edf1-49b9-8289-47d280676066',
  'b58defbb-df88-4ef0-9126-7be1dbeddf84',
  'acf1d119-17c6-47cb-99cc-55f52273620a',
  'bf7eb060-28c1-40d0-a753-a72784d36d39',
  '1c75c05c-d7fe-47eb-8946-def632a3b230',
  'a3c79b1d-91dc-438a-af7d-9028a8ddafa0',
  'ce8f9a3a-7bfd-49c0-8a95-003299b870af',
  'f2fd377a-33f6-4dc7-bde7-0210d80a7c1d',
  'b174c706-aed1-4af0-b4e9-8c80129aa3a3',
  '03048428-bd6d-4871-9182-4f0efc73d429',
  '1ca5ed2e-a77a-4c77-b6d3-d9ed2cf33c35',
  '750dd73b-3d0f-4baf-b410-e820bad5a0c8',
  'bd54a4a6-141a-4cb7-bd3f-3c36e513476c',
  'a0d04017-a68c-46fc-8686-ef75dc14e0f1',
  'e90fa59c-0fbb-4290-a3f4-abce82d20eb8',
  'c5db9d00-a358-4bff-a6ac-abaec9611817',
];

test('Fase 8C: migration restaura so os 4 no-ops conhecidos, com guards e auditoria', () => {
  assert.match(sql, /begin;/);
  assert.match(sql, /commit;/);
  assert.match(sql, /for update/);
  assert.match(sql, /get diagnostics v_updated = row_count/);
  assert.match(sql, /raise exception 'STOP 8C:/);
  assert.match(sql, /v_restored is distinct from 4/);
  assert.match(sql, /holder_links_restored/);
  assert.match(sql, /data_regularization/);
  assert.match(sql, /same_name_holder_noop_repair/);
  assert.match(sql, /restauracao de vinculo cadastral removido por same-name holder no-op/);
  assert.match(sql, /Daniel Stein Sutel/);
  assert.match(sql, /Maria Julia Dalavechia/);
  assert.match(sql, /Paulo Henrike da Rosa/);
  assert.match(sql, /Bruna Sell/);
  for (const id of TARGETS) {
    assert.match(sql, new RegExp(id));
  }
});

test('Fase 8C: 2052 permanece excluido e nenhum writer fora do escopo', () => {
  const executable = sql.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(executable, /a811f268-8fde-4cf2-85d9-27196a6fa9cc/);
  assert.doesNotMatch(executable, /Alessandro/);
  assert.doesNotMatch(executable, /Fabiano/);
  assert.doesNotMatch(executable, /apply_ticket_holder_name_internal/);
  assert.doesNotMatch(executable, /holder_changed/);
  assert.doesNotMatch(executable, /holder_assigned/);
  assert.doesNotMatch(executable, /holder_transferred/);
  assert.doesNotMatch(executable, /ticket_holder_history/);
  assert.doesNotMatch(executable, /update public\.orders/i);
  assert.doesNotMatch(executable, /holder_full_name\s*=/);
  assert.doesNotMatch(executable, /owner_user_id\s*=/);
  assert.doesNotMatch(executable, /intended_owner_contact_id\s*=/);
  assert.doesNotMatch(executable, /used_at\s*=/);
  assert.doesNotMatch(executable, /set status\s*=/);
  assert.doesNotMatch(sql, /db push/i);
});
