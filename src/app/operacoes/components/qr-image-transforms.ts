// Transformacoes de PIXEL puras usadas pela cadeia de fallback de cor do
// modo smallQrMode (ver useQrCameraScanner.ts). Extraidas pra um modulo sem
// nenhuma dependencia de DOM/canvas -- so operam sobre Uint8ClampedArray e
// numeros -- pra serem testaveis diretamente com node:test, sem precisar
// simular <video>/<canvas>.
//
// Causa raiz confirmada por teste fisico real (iPhone, comparando pulseiras
// de contraste diferente): o QR da pulseira e preto sobre rosa/roxo (marca
// do evento), o do ingresso e preto sobre branco. Luminancia do fundo:
// branco = 255, rosa (#EC4899) = ~130, roxo (#A855F7) = ~128 -- quase metade
// da margem de contraste antes de qualquer degradacao real de camera
// (reflexo, pouca luz, compressao de video). "Grayscale puro" foi testado e
// comprovado REDUNDANTE com RGB original (jsQR ja calcula luminancia e
// binariza a partir do RGB internamente) -- por isso nao faz parte daqui.

export function luminanceRange(data: Uint8ClampedArray): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  return { min, max };
}

/** Estica o histograma de luminancia pro range completo 0-255. `min`/`max` vem de luminanceRange() sobre os MESMOS dados. */
export function stretchContrast(data: Uint8ClampedArray, min: number, max: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  const scale = 255 / (max - min);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, (out[i] - min) * scale));
    out[i + 1] = Math.max(0, Math.min(255, (out[i + 1] - min) * scale));
    out[i + 2] = Math.max(0, Math.min(255, (out[i + 2] - min) * scale));
  }
  return out;
}

/**
 * Binariza usando um corte calculado a partir do min/max de luminancia da
 * PROPRIA regiao (nunca um valor fixo de pixel, que so serviria pra uma cor
 * de fundo especifica). `fraction` e a posicao do corte dentro do range
 * (0 = no minimo, 1 = no maximo; 0.5 = ponto medio classico).
 */
export function adaptiveThreshold(data: Uint8ClampedArray, min: number, max: number, fraction: number): Uint8ClampedArray {
  const cut = min + (max - min) * fraction;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < out.length; i += 4) {
    const luma = out[i] * 0.299 + out[i + 1] * 0.587 + out[i + 2] * 0.114;
    const v = luma < cut ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v;
  }
  return out;
}
