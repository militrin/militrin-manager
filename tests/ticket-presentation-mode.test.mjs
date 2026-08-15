import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTicketPresentationMode } from '../src/lib/checkout/ticket-presentation.ts';

test('0 categorias ativas -> single (Ingresso único)', () => {
  assert.equal(resolveTicketPresentationMode(0), 'single');
});

test('1 categoria ativa -> category_hidden (mostra so o lote, categoria continua canonica no backend)', () => {
  assert.equal(resolveTicketPresentationMode(1), 'category_hidden');
});

test('2+ categorias ativas -> category_visible (mostra categoria e lote)', () => {
  assert.equal(resolveTicketPresentationMode(2), 'category_visible');
  assert.equal(resolveTicketPresentationMode(5), 'category_visible');
});

test('contagem negativa/invalida nunca produz um modo de escolha inexistente', () => {
  assert.equal(resolveTicketPresentationMode(-1), 'single');
});
