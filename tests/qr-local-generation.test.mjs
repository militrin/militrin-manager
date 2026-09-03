import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateQrDataUrl } from '../src/lib/qr/generate-qr-data-url.ts';

test('QR operacional e data URL local, sem servico terceiro', async () => {
  const dataUrl = await generateQrDataUrl('ticket-token-operacional', 120);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.doesNotMatch(dataUrl, /qrserver|chart\.googleapis|goqr/i);
});

test('codigo operacional nao envia token para api.qrserver.com', async () => {
  const files = [
    '../src/lib/qr/generate-qr-data-url.ts',
    '../src/components/qr/LocalQrImage.tsx',
    '../src/app/minha-conta/ingressos/page.tsx',
    '../src/app/minha-conta/ingressos/[ticketId]/page.tsx',
    '../src/app/api/inscricao/pedidos/[orderId]/itens/[itemId]/qrcode/route.ts',
    '../src/app/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode/route.ts',
    '../src/app/api/loja/pedidos/[storeOrderId]/qrcode/route.ts',
  ];
  for (const relative of files) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /qrserver\.com|chart\.googleapis|goqr\.me/i, relative);
  }
});
