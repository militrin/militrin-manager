import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

const [actions, turbo, types, dashboard, reconcile] = await Promise.all([
  readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/operacoes/components/TurboMode.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/operations/operational-product-item.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/dashboard/admin-dashboard-data.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260890000000_reconcile_unified_event_shirt_demand.sql', import.meta.url), 'utf8'),
]);

test('T5 ticket normal QR → Turbo continua funcionando', () => {
  const fn = slice(actions, 'export async function resolveTurboScanAction', 'export async function deliverKitCheckinAndLinkWristbandAction');
  assert.match(fn, /\.from\("tickets"\)/);
  assert.match(fn, /\.eq\("token", tokenCandidate\)/);
  assert.match(fn, /kind: "ticket"/);
  assert.match(fn, /await assertPermission\("participants\.view"\)/);
});

test('T6 item adicional per_line → Turbo reconhece e entrega', () => {
  const identify = slice(actions, 'export async function resolveTurboScanAction', 'export async function deliverKitCheckinAndLinkWristbandAction');
  const storeFn = slice(actions, 'async function resolveStoreOrderItemByQr', 'async function resolveOrderItemProductByQr');
  assert.match(identify, /resolveOperationalProductByQr/);
  assert.doesNotMatch(identify, /assertPermission\("store\.deliver"\)/);
  assert.match(storeFn, /\.eq\("qr_token", tokenCandidate\)/);
  assert.match(storeFn, /pickup_qr_mode/);
  assert.match(storeFn, /person_name/);
  assert.match(actions, /export async function deliverAdditionalStoreItemAction/);
  assert.match(actions, /await assertPermission\("store\.deliver"\)/);
  assert.match(turbo, /function ProductReview\(/);
  assert.match(turbo, /label="Pessoa"/);
  assert.match(turbo, /Confirmar entrega/);
});

test('T7 item adicional per_unit → Turbo reconhece unidade correta', () => {
  const unified = slice(actions, 'async function resolveOperationalProductByQr', 'export async function resolveTurboScanAction');
  assert.match(unified, /resolveStoreOrderItemPickupUnitByQr/);
  assert.match(unified, /resolveOrderItemPickupUnitByQr/);
  const unitFn = slice(actions, 'async function resolveStoreOrderItemPickupUnitByQr', 'async function resolveOrderItemPickupUnitByQr');
  assert.match(unitFn, /\.from\("store_order_item_pickup_units"\)/);
  assert.match(unitFn, /\.eq\("qr_token", tokenCandidate\)/);
  assert.match(unitFn, /pickup_qr_mode: "per_unit"/);
  assert.match(unitFn, /parent_item_id/);
  assert.match(unitFn, /unit_index/);
  assert.match(types, /pickup_qr_mode: "per_unit" \| "per_line" \| "none"/);
});

test('T8 segunda leitura de item ja entregue → bloqueio/feedback correto', () => {
  const scan = slice(turbo, 'async function handleInitialScan(', 'async function handleNext(');
  assert.match(scan, /delivery_status === 'delivered'/);
  assert.match(scan, /SCAN_PRODUCT_DELIVERED/);
  assert.doesNotMatch(scan, /SCAN_ERROR[\s\S]*já entregue/);
  assert.match(turbo, /function ProductAlreadyDelivered\(/);
  assert.match(turbo, /Item já entregue/);
  assert.match(actions, /deliver_store_order_item/);
});

test('T9 item adicional com variant_id correto → estoque/entrega ajustado uma unica vez', () => {
  const dispatcher = slice(actions, 'export async function deliverOperationalProductItemAction', 'export async function undoOperationalProductDeliveryAction');
  assert.match(dispatcher, /item\.source === "store"/);
  assert.match(dispatcher, /deliverAdditionalStoreItemAction/);
  assert.match(dispatcher, /item\.source === "store_unit"/);
  assert.match(actions, /rpc\("deliver_store_order_item"/);
  assert.match(turbo, /deliverOperationalProductItemAction\(\{ source: item\.source, item_id: item\.item_id \}\)/);
});

test('T10 item adicional legitimo explica reserved > ticket count → integridade nao acusa falso positivo', () => {
  assert.match(reconcile, /from public\.participant_kit_items as kit_link/);
  assert.match(reconcile, /from public\.store_order_items as store_line/);
  assert.match(reconcile, /from public\.order_items as cart_line/);
  assert.match(reconcile, /item_kind='product'/);
  assert.match(dashboard, /event_kit_item_variant_inventory/);
  assert.doesNotMatch(dashboard, /reserved_quantity\s*>\s*.*tickets\.length/);
  assert.doesNotMatch(reconcile, /count\(\*\) from public\.tickets/);
});

test('dashboard pagina participant_kit_items — o falso 240 vinha do corte PostgREST em 1000', () => {
  assert.match(dashboard, /DASHBOARD_PAGE_SIZE = 1000/);
  assert.match(dashboard, /async function fetchAllScoped/);
  assert.match(dashboard, /\.range\(from, from \+ DASHBOARD_PAGE_SIZE - 1\)/);
  assert.match(dashboard, /from\('participant_kit_items'\)/);
  assert.match(dashboard, /fetchAllScoped\(\(\) => supabase\.from\('participant_kit_items'\)/);
});

test('ficha operacional tambem lista item adicional por contact, nao so participant_id', () => {
  assert.match(actions, /registration_contact_id\.eq\.\$\{contactId\}/);
  assert.match(actions, /referencedTable: "store_orders"/);
});
