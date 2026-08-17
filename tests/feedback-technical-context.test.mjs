import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEventSlugFromPath } from '../src/lib/feedback/technical-context.ts';

test('reconhece slug em rotas de evento conhecidas', () => {
  assert.equal(extractEventSlugFromPath('/eventos/esquenta-militrin'), 'esquenta-militrin');
  assert.equal(extractEventSlugFromPath('/inscricao/esquenta-militrin'), 'esquenta-militrin');
  assert.equal(extractEventSlugFromPath('/minha-conta/comprar/esquenta-militrin'), 'esquenta-militrin');
});

test('pega so o primeiro segmento apos o prefixo da rota', () => {
  assert.equal(extractEventSlugFromPath('/eventos/esquenta-militrin/detalhes'), 'esquenta-militrin');
});

test('rotas sem relacao com evento nao produzem slug (nunca inventa vinculo)', () => {
  assert.equal(extractEventSlugFromPath('/minha-conta'), null);
  assert.equal(extractEventSlugFromPath('/minha-conta/dados'), null);
  assert.equal(extractEventSlugFromPath('/painel/eventos/algum-id'), null);
  assert.equal(extractEventSlugFromPath(''), null);
});

test('decodifica caracteres de URL no slug', () => {
  assert.equal(extractEventSlugFromPath('/eventos/evento%20especial'), 'evento especial');
});
