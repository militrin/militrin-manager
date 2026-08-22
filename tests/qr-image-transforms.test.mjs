import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptiveThreshold, luminanceRange, stretchContrast } from '../src/app/operacoes/components/qr-image-transforms.ts';

function rgba(pixels) {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

function lumaAt(data, index) {
  return data[index * 4] * 0.299 + data[index * 4 + 1] * 0.587 + data[index * 4 + 2] * 0.114;
}

test('luminanceRange acha o min e o max reais entre os pixels (preto puro e rosa da marca, como no QR da pulseira)', () => {
  const data = rgba([
    [0, 0, 0], // preto (modulo do QR) -- luma 0
    [236, 72, 153], // rosa #EC4899 (fundo da pulseira) -- luma ~130.3
    [128, 128, 128], // cinza medio
  ]);
  const { min, max } = luminanceRange(data);
  assert.equal(min, 0);
  assert.ok(Math.abs(max - 130.3) < 1, `max esperado ~130.3, veio ${max}`);
});

test('stretchContrast estica o histograma pro range completo 0-255 -- imagem "lavada" (baixo contraste) vira alto contraste', () => {
  // Simula um crop de baixo contraste: luminancia so varia entre ~100 e ~150
  // (como um QR rosa com reflexo/pouca luz) -- exatamente o cenario real
  // encontrado na auditoria (fundo rosa ~130 de luminancia, bem mais perto
  // do preto do modulo do que o branco 255 do ingresso).
  const data = rgba([
    [100, 100, 100], // mais escuro do grupo
    [150, 150, 150], // mais claro do grupo
  ]);
  const { min, max } = luminanceRange(data);
  const stretched = stretchContrast(data, min, max);
  const lumaMin = Math.min(lumaAt(stretched, 0), lumaAt(stretched, 1));
  const lumaMax = Math.max(lumaAt(stretched, 0), lumaAt(stretched, 1));
  assert.ok(lumaMin < 5, `pixel mais escuro deveria virar ~0 apos esticar, veio ${lumaMin}`);
  assert.ok(lumaMax > 250, `pixel mais claro deveria virar ~255 apos esticar, veio ${lumaMax}`);
});

test('stretchContrast preserva a ORDEM relativa (nunca inverte escuro/claro)', () => {
  const data = rgba([
    [236, 72, 153], // rosa (fundo) -- mais claro
    [40, 10, 25], // module escuro, mas nao preto puro (sombra/reflexo leve)
  ]);
  const { min, max } = luminanceRange(data);
  const stretched = stretchContrast(data, min, max);
  assert.ok(lumaAt(stretched, 0) > lumaAt(stretched, 1), 'o pixel originalmente mais claro precisa continuar mais claro depois de esticar');
});

test('adaptiveThreshold binariza em 0 ou 255 (nunca um valor intermediario)', () => {
  const data = rgba([
    [0, 0, 0],
    [236, 72, 153],
    [90, 90, 90],
  ]);
  const { min, max } = luminanceRange(data);
  const binarized = adaptiveThreshold(data, min, max, 0.5);
  for (let i = 0; i < 3; i++) {
    const l = lumaAt(binarized, i);
    assert.ok(l === 0 || l === 255, `pixel ${i} deveria ser 0 ou 255 apos threshold, veio ${l}`);
  }
});

test('adaptiveThreshold usa o corte RELATIVO ao min/max da propria regiao, nunca um pixel fixo -- o mesmo pixel pode binarizar diferente dependendo da fracao', () => {
  // range 0-100: um pixel de luma ~40 fica ACIMA do corte em fraction=0.35
  // (corte=35) -- vira branco -- mas ABAIXO do corte em fraction=0.5
  // (corte=50) -- vira preto. Isso e exatamente por isso que usamos 3
  // fracoes em vez de um unico threshold fixo (auditoria: um valor fixo de
  // pixel so funciona pra UMA cor de fundo especifica).
  const min = 0;
  const max = 100;
  const midGray = rgba([[134, 0, 0]]); // luma = 134*0.299 = 40.07 -- fica entre os 2 cortes
  const atFraction35 = adaptiveThreshold(midGray, min, max, 0.35);
  const atFraction50 = adaptiveThreshold(midGray, min, max, 0.5);
  assert.equal(lumaAt(atFraction35, 0), 255, 'luma 40 esta ACIMA do corte 35 (0.35 do range) -- deveria virar branco');
  assert.equal(lumaAt(atFraction50, 0), 0, 'luma 40 esta ABAIXO do corte 50 (0.5 do range) -- deveria virar preto');
});
