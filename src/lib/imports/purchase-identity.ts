import { createHash } from 'node:crypto';

export type PurchaseFingerprintInput = {
  fullName?: string | null;
  cpfInput?: string | null;
  emailInput?: string | null;
  phoneInput?: string | null;
  category?: string | null;
  batch?: string | null;
  shirtType?: string | null;
  shirtSize?: string | null;
  amount?: number | null;
  paymentMethod?: string | null;
  externalPurchaseKey?: string | null;
};

function normalizeFingerprintPart(value: string | null | undefined) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashSourceFileBytes(bytes: ArrayBuffer | Uint8Array | Buffer) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer);
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildPurchaseFingerprint(input: PurchaseFingerprintInput) {
  const payload = [
    `name:${normalizeFingerprintPart(input.fullName)}`,
    `cpf:${String(input.cpfInput ?? '').replace(/\D/g, '')}`,
    `email:${normalizeFingerprintPart(input.emailInput)}`,
    `phone:${String(input.phoneInput ?? '').replace(/\D/g, '')}`,
    `category:${normalizeFingerprintPart(input.category)}`,
    `batch:${normalizeFingerprintPart(input.batch)}`,
    `shirt:${normalizeFingerprintPart(input.shirtType)}|${normalizeFingerprintPart(input.shirtSize)}`,
    `amount:${input.amount == null || !Number.isFinite(input.amount) ? '' : String(input.amount)}`,
    `pay:${normalizeFingerprintPart(input.paymentMethod)}`,
    `ext:${normalizeFingerprintPart(input.externalPurchaseKey)}`,
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

export function assignOccurrenceIndexes(fingerprints: string[]) {
  const seen = new Map<string, number>();
  return fingerprints.map((fingerprint) => {
    const next = (seen.get(fingerprint) ?? 0) + 1;
    seen.set(fingerprint, next);
    return next;
  });
}

export function purchaseOccurrenceKey(input: {
  sourceFileHash: string;
  rowFingerprint: string;
  occurrenceIndex: number;
}) {
  return `${input.sourceFileHash}:${input.rowFingerprint}:${input.occurrenceIndex}`;
}

export const EXTERNAL_PURCHASE_KEY_ALIASES = [
  'pedido',
  'pedido original',
  'numero do pedido',
  'n pedido',
  'inscricao',
  'inscrição',
  'transaction',
  'transaction id',
  'transaction_id',
  'response id',
  'response_id',
  'google forms',
  'google forms id',
];
