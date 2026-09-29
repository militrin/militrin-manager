import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRISTBAND_QR_UNRECOGNIZED = 'QR não reconhecido como pulseira.';

function parseTokenCandidate(rawValue) {
  const value = rawValue.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.searchParams.get('token') ?? url.pathname.split('/').filter(Boolean).pop() ?? value;
  } catch {
    return value;
  }
}

function parseTicketDisplayCode(raw) {
  const normalized = String(raw ?? '').trim().replace(/\s+/g, '');
  return /^#?0*([1-9][0-9]{0,17})-0*([1-9][0-9]{0,8})$/.test(normalized);
}

function parseWristbandScan(rawValue) {
  const code = parseTokenCandidate(rawValue);
  if (!code) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  if (UUID_PATTERN.test(code)) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  if (parseTicketDisplayCode(code)) return { ok: false, message: WRISTBAND_QR_UNRECOGNIZED };
  return { ok: true, code };
}

test('QR invalido nao vira codigo de pulseira', () => {
  assert.deepEqual(parseWristbandScan(''), { ok: false, message: WRISTBAND_QR_UNRECOGNIZED });
  assert.deepEqual(parseWristbandScan('7e1ce025-8ac6-4c1a-b11e-8b5b01be1d30'), { ok: false, message: WRISTBAND_QR_UNRECOGNIZED });
  assert.deepEqual(parseWristbandScan('https://www.militrin.com.br/ingresso?token=7e1ce025-8ac6-4c1a-b11e-8b5b01be1d30'), {
    ok: false,
    message: WRISTBAND_QR_UNRECOGNIZED,
  });
  assert.deepEqual(parseWristbandScan('#001862-01'), { ok: false, message: WRISTBAND_QR_UNRECOGNIZED });
});

test('scan valido segue o codigo canonico da pulseira', () => {
  assert.deepEqual(parseWristbandScan('050221801021167116'), { ok: true, code: '050221801021167116' });
  assert.deepEqual(parseWristbandScan(' https://pulseira.local/050221801021167116 '), { ok: true, code: '050221801021167116' });
});

test('Ler pulseira reusa QrScanner e nao aparece com pulseira ja vinculada', async () => {
  const [modal, confirm, expanded, row, scan] = await Promise.all([
    read('src/app/operacoes/components/WristbandCodeModal.tsx'),
    read('src/app/operacoes/components/ConfirmCheckinDialog.tsx'),
    read('src/app/operacoes/components/ExpandedTicketDetails.tsx'),
    read('src/app/operacoes/components/OperationRow.tsx'),
    read('src/lib/operations/wristband-scan.ts'),
  ]);
  assert.match(modal, /Ler pulseira/);
  assert.match(modal, /from "\.\/QrScanner"/);
  assert.match(modal, /parseWristbandScan/);
  assert.match(scan, /QR não reconhecido como pulseira/);
  assert.match(modal, /holder_name/);
  assert.match(modal, /Abrir ingresso relacionado/);
  assert.match(modal, /Leitor USB/);
  assert.match(modal, /square/);
  assert.match(modal, /max-w-md/);
  assert.match(modal, /min-h-12/);
  assert.match(confirm, /Vinculada/);
  assert.match(confirm, /Nenhuma pulseira nova será lida/);
  assert.match(expanded, /if \(hasActiveWristband\) \{\s*setShowCheckinConfirm\(true\)/);
  assert.match(expanded, /setWristbandModal\("mandatory-checkin"\)/);
  assert.match(row, /if \(hasActiveWristband\) \{\s*setShowCheckinConfirm\(true\)/);
  assert.doesNotMatch(modal, /assertPermission/);
});

test('pulseira de outro ingresso nao sobrescreve — erro canonico', async () => {
  const [modal, errors] = await Promise.all([
    read('src/app/operacoes/components/WristbandCodeModal.tsx'),
    read('src/app/operacoes/error-messages.ts'),
  ]);
  assert.match(errors, /WRISTBAND_LINKED_TO_ANOTHER_TICKET/);
  assert.match(modal, /holder_name/);
  assert.match(modal, /Abrir ingresso relacionado/);
  assert.doesNotMatch(modal, /replaceWristbandAction|onReplace/);
});

test('RBAC de check-in e vinculo permanece nas actions, nao no scanner', async () => {
  const [expanded, modal] = await Promise.all([
    read('src/app/operacoes/components/ExpandedTicketDetails.tsx'),
    read('src/app/operacoes/components/WristbandCodeModal.tsx'),
  ]);
  assert.match(expanded, /capabilities\.canCheckin/);
  assert.match(expanded, /capabilities\.canLinkWristband/);
  assert.doesNotMatch(modal, /wristbands\.link|checkin\.scan/);
});
