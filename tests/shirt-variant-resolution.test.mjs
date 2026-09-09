import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveShirtVariant,
  shirtVariantReviewIssue,
} from '../src/lib/imports/shirt-variant.ts';

const catalog = [
  { id: 'baby-g', name: 'Babylook', value: 'G', is_active: true },
  { id: 'cam-m', name: 'Camiseta', value: 'M', is_active: true },
  { id: 'cam-eg', name: 'Camiseta', value: 'EG', is_active: true },
];

test('import Babylook G resolve variant_id correto', () => {
  const resolved = resolveShirtVariant(catalog, 'Babylook', 'G');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.variantId, 'baby-g');
  assert.equal(shirtVariantReviewIssue(resolved, 'Babylook', 'G'), null);
});

test('import Camiseta M resolve variant_id correto', () => {
  const resolved = resolveShirtVariant(catalog, 'camiseta', 'm');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.variantId, 'cam-m');
});

test('0 variantes -> review, sem escolha silenciosa', () => {
  const resolved = resolveShirtVariant(catalog, 'Camiseta', 'PP');
  assert.equal(resolved.status, 'missing');
  assert.equal(resolved.variantId, null);
  const issue = shirtVariantReviewIssue(resolved, 'Camiseta', 'PP');
  assert.equal(issue?.issue_type, 'invalid_variant');
});

test('>1 variante -> review, sem escolha silenciosa', () => {
  const ambiguous = [
    { id: 'a', name: 'Camiseta', value: 'M', is_active: true },
    { id: 'b', name: 'Camiseta', value: 'M', is_active: true },
  ];
  const resolved = resolveShirtVariant(ambiguous, 'Camiseta', 'M');
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.matchCount, 2);
  assert.equal(resolved.variantId, null);
  const issue = shirtVariantReviewIssue(resolved, 'Camiseta', 'M');
  assert.equal(issue?.issue_type, 'ambiguous_variant');
});

test('tipo ou tamanho vazio nao inventa variante', () => {
  assert.equal(resolveShirtVariant(catalog, '', 'M').status, 'unspecified');
  assert.equal(resolveShirtVariant(catalog, 'Camiseta', null).status, 'unspecified');
});
