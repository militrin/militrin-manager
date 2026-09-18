import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const paymentPage = fileURLToPath(new URL('../src/app/financeiro/pagamento/[paymentId]/page.tsx', import.meta.url));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function paymentsSelects(source) {
  const selects = [];
  const fromRe = /\.from\(\s*['"]payments['"]\s*\)/g;
  let fromMatch;
  while ((fromMatch = fromRe.exec(source))) {
    const window = source.slice(fromMatch.index, fromMatch.index + 1200);
    const selectMatch = window.match(/\.select\(\s*(['"`])([\s\S]*?)\1/);
    if (selectMatch) selects.push(selectMatch[2].replace(/\s+/g, ' '));
  }
  return selects;
}

test('ficha de pagamento desambigua payments→orders por payments_order_id_fkey', async () => {
  const source = await readFile(paymentPage, 'utf8');
  assert.match(source, /orders!payments_order_id_fkey\(/);
  assert.doesNotMatch(source, /created_at,orders\(/);
});

test('nenhum select payments→orders em src fica sem hint de FK', async () => {
  const files = await walk(srcRoot);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const select of paymentsSelects(source)) {
      if (!/\borders\s*[!(]/.test(select)) continue;
      if (!select.includes('orders!payments_order_id_fkey')) {
        offenders.push(`${path.relative(srcRoot, file)}: ${select.slice(0, 180)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
