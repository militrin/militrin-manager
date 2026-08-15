import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCarouselDotTargets, findActiveDotIndex } from '../src/lib/account/carousel-dots.ts';

test('total menor ou igual ao maximo: um indicador por item', () => {
  assert.deepEqual(buildCarouselDotTargets(1), [0]);
  assert.deepEqual(buildCarouselDotTargets(3), [0, 1, 2]);
  assert.deepEqual(buildCarouselDotTargets(5), [0, 1, 2, 3, 4]);
});

test('zero itens: nenhum indicador', () => {
  assert.deepEqual(buildCarouselDotTargets(0), []);
});

test('total maior que o maximo: nunca mais que maxDots indicadores, sempre cobrindo do primeiro ao ultimo item', () => {
  const targets = buildCarouselDotTargets(20, 5);
  assert.equal(targets.length, 5, 'nao pode virar uma bolinha por ingresso quando ha muitos');
  assert.equal(targets[0], 0, 'primeiro indicador sempre aponta para o primeiro item');
  assert.equal(targets.at(-1), 19, 'ultimo indicador sempre aponta para o ultimo item');
  assert.deepEqual(targets, [...new Set(targets)], 'indicadores nao podem se repetir');
});

test('respeita maxDots customizado', () => {
  assert.equal(buildCarouselDotTargets(50, 3).length, 3);
});

test('indicador ativo e o mais proximo do indice atual', () => {
  const targets = buildCarouselDotTargets(20, 5); // [0, 5, 9 ou 10, 14 ou 15, 19]
  assert.equal(findActiveDotIndex(targets, 0), 0);
  assert.equal(findActiveDotIndex(targets, 19), 4);
  assert.equal(findActiveDotIndex(targets, targets[2]), 2, 'exatamente no alvo do indicador do meio');
});

test('lista vazia de indicadores nao quebra a busca do ativo', () => {
  assert.equal(findActiveDotIndex([], 0), -1);
});
