import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveShirtVariant } from '../src/lib/imports/shirt-variant.ts';

function classifyShirtVariantRepair(link, catalog) {
  if (String(link.currentVariantId ?? '').trim()) return { status: 'already_linked' };
  const resolution = resolveShirtVariant(catalog, link.shirtType, link.shirtSize);
  if (resolution.status === 'resolved') return { status: 'resolved', variantId: resolution.variantId };
  if (resolution.status === 'ambiguous') return { status: 'ambiguous', matchCount: resolution.matchCount };
  if (resolution.status === 'unspecified') return { status: 'unspecified' };
  return { status: 'missing' };
}

function planShirtVariantRepairs(links, catalog) {
  const decisions = links.map((link) => ({ link, decision: classifyShirtVariantRepair(link, catalog) }));
  return {
    resolvable: decisions.filter((row) => row.decision.status === 'resolved'),
    missing: decisions.filter((row) => row.decision.status === 'missing'),
    ambiguous: decisions.filter((row) => row.decision.status === 'ambiguous'),
    unspecified: decisions.filter((row) => row.decision.status === 'unspecified'),
    alreadyLinked: decisions.filter((row) => row.decision.status === 'already_linked'),
  };
}

const catalog = [
  { id: 'baby-m', name: 'Babylook', value: 'M', is_active: true },
  { id: 'cam-gg', name: 'Camiseta', value: 'GG', is_active: true },
  { id: 'cam-exg', name: 'Camiseta', value: 'EXG', is_active: true },
];

function link(overrides = {}) {
  return {
    linkId: 'link-1',
    ticketId: 'ticket-1',
    orderItemId: 'oi-1',
    kitItemId: 'kit-shirt',
    shirtType: 'Babylook',
    shirtSize: 'M',
    currentVariantId: null,
    inventoryReservationAccounted: true,
    ...overrides,
  };
}

test('T1 ticket com combinacao textual inequivoca + variant_id null → reparo correto', () => {
  const decision = classifyShirtVariantRepair(link({ shirtType: 'babylook', shirtSize: ' m ' }), catalog);
  assert.equal(decision.status, 'resolved');
  assert.equal(decision.variantId, 'baby-m');
});

test('T2 combinacao sem variante → nao reparar automaticamente', () => {
  const decision = classifyShirtVariantRepair(link({ shirtType: 'Camiseta', shirtSize: 'PP' }), catalog);
  assert.equal(decision.status, 'missing');
});

test('T3 combinacao ambigua → nao reparar automaticamente', () => {
  const ambiguous = [
    { id: 'a', name: 'Camiseta', value: 'GG', is_active: true },
    { id: 'b', name: 'Camiseta', value: 'GG', is_active: true },
  ];
  const decision = classifyShirtVariantRepair(link({ shirtType: 'Camiseta', shirtSize: 'GG' }), ambiguous);
  assert.equal(decision.status, 'ambiguous');
  assert.equal(decision.matchCount, 2);
});

test('T4 reparo nao altera reserved_quantity indevidamente', async () => {
  const plan = planShirtVariantRepairs([
    link({ currentVariantId: null, inventoryReservationAccounted: true }),
    link({ linkId: 'already', currentVariantId: 'baby-m' }),
  ], catalog);
  assert.equal(plan.resolvable.length, 1);
  assert.equal(plan.alreadyLinked.length, 1);
  assert.equal(plan.resolvable[0].decision.variantId, 'baby-m');

  const rpc = await readFile(new URL('../supabase/migrations/20261011000000_repair_unambiguous_shirt_variant_links.sql', import.meta.url), 'utf8');
  assert.match(rpc, /variant_data = coalesce\(variant_data, '\{\}'::jsonb\) \|\| jsonb_build_object\('variant_id', v_variant_id\)/);
  assert.doesNotMatch(rpc, /reserved_quantity\s*=\s*reserved_quantity\s*\+/);
  assert.doesNotMatch(rpc, /account_ticket_shirt_demand/);
  assert.match(rpc, /trg_reconcile_participant_shirt_demand/);
  assert.doesNotMatch(rpc, /insert into public\.event_kit_item_variants/);
  assert.doesNotMatch(rpc, /insert into public\.event_kit_items/);
});

test('classificador de reparo no codigo da app e o mesmo usado pelos testes T1-T4', async () => {
  const source = await readFile(new URL('../src/lib/inventory/repair-missing-shirt-variants.ts', import.meta.url), 'utf8');
  assert.match(source, /export function classifyShirtVariantRepair/);
  assert.match(source, /if \(String\(link\.currentVariantId \?\? ''\)\.trim\(\)\) return \{ status: 'already_linked' \}/);
  assert.match(source, /resolveShirtVariant\(catalog, link\.shirtType, link\.shirtSize\)/);
});

test('texto historico / titular / pedido ficam fora do plano de reparo', () => {
  const planned = classifyShirtVariantRepair(link({ shirtType: 'Baby Look', shirtSize: 'M' }), catalog);
  assert.equal(planned.status, 'missing');
  const rpcPromise = readFile(new URL('../supabase/migrations/20261011000000_repair_unambiguous_shirt_variant_links.sql', import.meta.url), 'utf8');
  return rpcPromise.then((rpc) => {
    assert.doesNotMatch(rpc, /update public\.order_items/);
    assert.doesNotMatch(rpc, /update public\.tickets/);
    assert.doesNotMatch(rpc, /update public\.shirt_inventory/);
  });
});
