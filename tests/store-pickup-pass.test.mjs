import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateQrDataUrl } from '../src/lib/qr/generate-qr-data-url.ts';
import { parseStoreOrderScanRef } from '../src/lib/operations/store-order-scan-ref.ts';
import {
  buildStorePickupPassData,
  isOperationalStoreQrPayload,
  pickStoreProductImageUrl,
  resolveStorePickupQrPayload,
  STORE_PICKUP_PASS_COPY,
} from '../src/lib/store/store-pickup-pass.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const ORDER_1121 = {
  productName: 'Camiseta Militrin 2026',
  variant: { name: 'Camiseta', value: 'GG' },
  quantity: 1,
  displayNumber: 1121,
  orderNumber: 'ADMIN-20260909-abc3bda0',
  orderCreatedAt: '2026-09-09T15:00:00.000Z',
  paymentStatus: 'paid',
  pickupQrMode: 'per_line',
  itemQrToken: 'ITEM-95F7F18C8796',
  eventName: 'Militrin 2026',
};

test('QR canônico per_line usa ITEM- e nunca #display nem order_number', () => {
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_line',
      quantity: 1,
      itemQrToken: 'ITEM-95F7F18C8796',
    }),
    'ITEM-95F7F18C8796',
  );
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_line',
      quantity: 1,
      itemQrToken: '#001121',
    }),
    null,
  );
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_line',
      quantity: 1,
      itemQrToken: 'ADMIN-20260909-abc3bda0',
    }),
    null,
  );
});

test('QR canônico per_unit usa UNIT- da unidade quando quantity > 1', () => {
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_unit',
      quantity: 2,
      itemQrToken: 'ITEM-AAAA',
      unitQrToken: 'UNIT-BBBBCCCCDDDD',
    }),
    'UNIT-BBBBCCCCDDDD',
  );
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_unit',
      quantity: 2,
      itemQrToken: 'ITEM-AAAA',
    }),
    null,
  );
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'per_unit',
      quantity: 1,
      itemQrToken: 'ITEM-AAAA',
    }),
    'ITEM-AAAA',
  );
});

test('pickup_qr_mode none não gera QR', () => {
  assert.equal(
    resolveStorePickupQrPayload({
      pickupQrMode: 'none',
      quantity: 1,
      itemQrToken: 'ITEM-95F7F18C8796',
    }),
    null,
  );
});

test('#001121 entregue: ITEM RETIRADO, QR ITEM- visível, sem instrução de nova retirada', () => {
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'delivered',
    deliveredAt: '2026-09-14T21:15:47.252Z',
  });
  assert.equal(pass.orderNumber, '#001121');
  assert.equal(pass.productName, 'Camiseta Militrin 2026');
  assert.equal(pass.variantLabel, 'Camiseta GG');
  assert.equal(pass.quantityLabel, '1 unidade');
  assert.equal(pass.qrPayload, 'ITEM-95F7F18C8796');
  assert.equal(pass.canShowQr, true);
  assert.equal(pass.pickupStatus, 'delivered');
  assert.equal(pass.pickupStatusLabel, STORE_PICKUP_PASS_COPY.pickupDelivered);
  assert.equal(pass.paymentStatusLabel, STORE_PICKUP_PASS_COPY.paymentConfirmed);
  assert.equal(pass.instruction, STORE_PICKUP_PASS_COPY.instructionDelivered);
  assert.equal(pass.instruction, 'Item já retirado.');
  assert.doesNotMatch(pass.instruction, /Apresente este QR/);
  assert.equal(isOperationalStoreQrPayload(pass.qrPayload), true);
  assert.deepEqual(parseStoreOrderScanRef(pass.qrPayload), { displayNumber: null, orderNumber: null });
});

test('item pendente mostra retirada pendente e instrução de apresentar QR', () => {
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'confirmed',
    deliveredAt: null,
  });
  assert.equal(pass.pickupStatus, 'pending');
  assert.equal(pass.pickupStatusLabel, STORE_PICKUP_PASS_COPY.pickupPending);
  assert.equal(pass.instruction, STORE_PICKUP_PASS_COPY.instructionPending);
  assert.equal(pass.qrPayload, 'ITEM-95F7F18C8796');
});

test('imagem primária cadastrada é usada; sem imagem o fallback fica nulo', () => {
  assert.equal(
    pickStoreProductImageUrl([
      { image_url: 'https://cdn.example/a.png', is_primary: false, sort_order: 0 },
      { image_url: 'https://cdn.example/b.png', is_primary: true, sort_order: 1 },
    ]),
    'https://cdn.example/b.png',
  );
  assert.equal(pickStoreProductImageUrl([]), null);
});

test('QR gerado da ficha é o token operacional, distinto de #001121', async () => {
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'delivered',
    deliveredAt: '2026-09-14T21:15:47.252Z',
  });
  const itemQr = await generateQrDataUrl(pass.qrPayload, 120);
  const receiptQr = await generateQrDataUrl('#001121', 120);
  assert.match(itemQr, /^data:image\/png;base64,/);
  assert.notEqual(itemQr, receiptQr);
});

test('QR PNG do comprovante decodifica ITEM-95F7F18C8796, o mesmo token do Turbo', async () => {
  const { PNG } = await import('pngjs');
  const jsQR = (await import('jsqr')).default;
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'confirmed',
    deliveredAt: null,
  });
  const dataUrl = await generateQrDataUrl(pass.qrPayload, 640);
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength), png.width, png.height);
  assert.equal(decoded?.data, 'ITEM-95F7F18C8796');
  const actions = await read('src/app/operacoes/actions.ts');
  const start = actions.indexOf('async function resolveStoreOrderItemByQr');
  const end = actions.indexOf('async function resolveOrderItemProductByQr', start);
  const storeFn = actions.slice(start, end);
  assert.match(storeFn, /\.eq\("qr_token", tokenCandidate\)/);
});

test('Minha Conta Loja usa o model compartilhado e não o QR de pedido na ficha', async () => {
  const itemPage = await read('src/app/minha-conta/compras/loja/[storeOrderId]/itens/[itemId]/page.tsx');
  const orderPage = await read('src/app/minha-conta/compras/loja/[storeOrderId]/page.tsx');
  const listPage = await read('src/app/minha-conta/compras/page.tsx');
  const actions = await read('src/components/store/StorePickupPassActions.tsx');
  assert.match(itemPage, /buildStorePickupPassData/);
  assert.match(itemPage, /StorePickupPass/);
  assert.doesNotMatch(itemPage, /ProductQrViewer/);
  assert.doesNotMatch(orderPage, /StoreOrderReceiptButtons/);
  assert.match(listPage, /StorePurchaseListCard/);
  assert.match(actions, /generateQrDataUrl\(pass\.qrPayload/);
  assert.match(actions, /createStorePickupPdfDocument/);
  assert.doesNotMatch(actions, /generateQrDataUrl\(orderNumber/);
});

test('PDF de retirada é retrato A4, incorpora o QR e usa o mesmo payload ITEM-', async () => {
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'confirmed',
    deliveredAt: null,
  });
  assert.equal(pass.qrPayload, 'ITEM-95F7F18C8796');
  const [{ jsPDF }, qrDataUrl, exportModule] = await Promise.all([
    import('jspdf'),
    generateQrDataUrl(pass.qrPayload, 640),
    import('../src/components/store/store-pickup-pass-export.ts'),
  ]);
  const {
    createStorePickupPdfDocument,
    drawStorePickupPassPdf,
    STORE_PICKUP_PDF_QR,
  } = exportModule;
  const doc = new jsPDF(createStorePickupPdfDocument());
  assert.ok(doc.internal.pageSize.getHeight() > doc.internal.pageSize.getWidth());
  const drawn = drawStorePickupPassPdf(doc, pass, { qrDataUrl, logoDataUrl: null, productDataUrl: null });
  assert.ok(drawn.qr);
  assert.equal(drawn.qr.size, STORE_PICKUP_PDF_QR.size);
  assert.ok(drawn.qr.x + drawn.qr.size < doc.internal.pageSize.getWidth());
  assert.ok(drawn.qr.y + drawn.qr.size < doc.internal.pageSize.getHeight());
  const qrImage = doc.getImageProperties(qrDataUrl);
  assert.ok(qrImage);
  assert.ok(qrImage.width >= 240);
  assert.ok(qrImage.height >= 240);
  const pdf = doc.output('arraybuffer');
  assert.ok(pdf.byteLength > 4000);
  const pdfText = Buffer.from(pdf).toString('latin1');
  assert.match(pdfText, /\/Subtype\s*\/Image/);
  assert.match(pdfText, /Camiseta Militrin 2026/);
  assert.match(pdfText, /#001121/);
  assert.match(pdfText, /Apresente este QR Code na retirada do seu item/);

  const source = await read('src/components/store/store-pickup-pass-export.ts');
  assert.match(source, /export function drawStorePickupPassPdf/);
  assert.match(source, /export function drawStorePickupPassPng/);
  assert.match(source, /format: 'a4'/);
  assert.match(source, /orientation: 'portrait'/);
  assert.match(source, /STORE_PICKUP_PDF_QR_ALIAS/);
  assert.match(source, /'NONE'/);
  assert.doesNotMatch(source, /width: 720, height: 430/);
  assert.doesNotMatch(source, /Acesso Militrin|HopWatermark/);
});

test('PDF entregue mostra ITEM RETIRADO e Item já retirado, sem instrução pendente', async () => {
  const pass = buildStorePickupPassData({
    ...ORDER_1121,
    itemStatus: 'delivered',
    deliveredAt: '2026-09-14T21:15:47.252Z',
  });
  const [{ jsPDF }, qrDataUrl, { createStorePickupPdfDocument, drawStorePickupPassPdf }] = await Promise.all([
    import('jspdf'),
    generateQrDataUrl(pass.qrPayload, 640),
    import('../src/components/store/store-pickup-pass-export.ts'),
  ]);
  const doc = new jsPDF(createStorePickupPdfDocument());
  drawStorePickupPassPdf(doc, pass, { qrDataUrl, logoDataUrl: null, productDataUrl: null });
  assert.ok(doc.getImageProperties(qrDataUrl));
  const pdfText = Buffer.from(doc.output('arraybuffer')).toString('latin1');
  assert.match(pdfText, /ITEM RETIRADO/);
  assert.match(pdfText, /Item j/);
  assert.match(pdfText, /retirado/);
  assert.match(pdfText, /14\/09\/2026/);
  assert.doesNotMatch(pdfText, /Apresente este QR Code na retirada do seu item/);
});
