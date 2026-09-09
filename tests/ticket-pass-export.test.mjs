import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { parseCssColorToRgb } from '../src/components/ticket-pass/ticket-pass-accent.ts';

test('parser de accent aceita hex e rgb computado pelo browser', () => {
  assert.deepEqual(parseCssColorToRgb('#22c55e', [0, 0, 0]), [34, 197, 94]);
  assert.deepEqual(parseCssColorToRgb('rgb(34, 197, 94)', [0, 0, 0]), [34, 197, 94]);
  assert.deepEqual(parseCssColorToRgb('rgba(34, 197, 94, 1)', [0, 0, 0]), [34, 197, 94]);
  assert.deepEqual(parseCssColorToRgb('not-a-color', [1, 2, 3]), [1, 2, 3]);
});

test('componentes visuais do Event Pass nao hardcodam rosa', async () => {
  const dir = new URL('../src/components/ticket-pass/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.tsx'));
  assert.ok(files.includes('TicketPass.tsx'));
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /#ec4899|pink-\d+|from-pink|text-pink|bg-pink|ring-pink/i, name);
  }
});

test('exportacao do ingresso usa o token real via generateQrDataUrl e nao o tema de relatorio', async () => {
  const source = await readFile(new URL('../src/components/public/TicketPdfButton.tsx', import.meta.url), 'utf8');
  assert.match(source, /generateQrDataUrl\(model\.token, TICKET_PASS_EXPORT_QR_SIZE\)/);
  assert.match(source, /drawTicketPassPdf/);
  assert.match(source, /drawTicketPassPng/);
  assert.match(source, /Baixar imagem|TICKET_PASS_COPY\.downloadImage/);
  assert.doesNotMatch(source, /applyReportPage|finalizeReportPages|REPORT_THEME/);
});
