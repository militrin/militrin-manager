import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hook = await readFile(new URL("../src/app/operacoes/components/useQrCameraScanner.ts", import.meta.url), "utf8");
const qrScanner = await readFile(new URL("../src/app/operacoes/components/QrScanner.tsx", import.meta.url), "utf8");
const qrScannerModal = await readFile(new URL("../src/app/operacoes/components/QrScannerModal.tsx", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

test("jsqr esta declarado como dependencia real (nao so instalado solto) -- nenhuma segunda biblioteca de QR foi adicionada", () => {
  assert.equal(packageJson.dependencies.jsqr, "^1.4.0");
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies), /zxing|qr-scanner|html5-qrcode|instascan/i);
});

test("hook decodifica com BarcodeDetector quando disponivel, e cai pra jsQR multi-escala via canvas quando nao existir", () => {
  assert.match(hook, /import jsQR from "jsqr"/);
  assert.match(hook, /function getBarcodeDetector\(\)/);
  assert.match(hook, /window\.BarcodeDetector/);
  const detectFn = slice(hook, "async function detectFromVideo", "if (cancelled) return;\n        setStatus");
  assert.match(detectFn, /if \(detector\) \{/);
  assert.match(detectFn, /return decodeWithJsQR\(canvas, context, video\)/);
  const decodeRegionFn = slice(hook, "function decodeRegionWithJsQR", "function decodeWithJsQR");
  assert.match(decodeRegionFn, /jsQR\(imageData\.data, imageData\.width, imageData\.height/);
});

test("camera pede resolucao maior (ideal 1280x720) em vez de deixar no padrao baixo do navegador", () => {
  const start = slice(hook, "async function start", "if \\(cancelled\\) {".replace(/\\/g, ""));
  assert.match(start, /getUserMedia\(\{/);
  assert.match(start, /width:\s*\{\s*ideal:\s*1280\s*\}/);
  assert.match(start, /height:\s*\{\s*ideal:\s*720\s*\}/);
  assert.match(start, /facingMode:\s*\{\s*ideal:\s*"environment"\s*\}/);
});

test("frame completo nunca reduz cegamente pra 480px -- alvo agora e 640px, so reduz quando a fonte for maior", () => {
  assert.match(hook, /FULL_FRAME_TARGET_WIDTH = 640/);
  assert.doesNotMatch(hook, /\b480\b/);
});

test("analise multi-escala: frame completo -> crop central -> crop central ampliado (upscale), parando no primeiro sucesso", () => {
  const fn = slice(hook, "function decodeWithJsQR", "export function useQrCameraScanner");
  const fullIdx = fn.indexOf("decodeRegionWithJsQR(canvas, context, video, 0, 0, vw, vh");
  const cropIdx = fn.indexOf("CENTER_CROP_RATIO");
  const enlargedIdx = fn.indexOf("CENTER_CROP_ENLARGED_RATIO");
  assert.ok(fullIdx !== -1 && cropIdx !== -1 && enlargedIdx !== -1, "as 3 etapas (frame completo, crop central, crop ampliado) precisam existir");
  assert.ok(fullIdx < cropIdx && cropIdx < enlargedIdx, "ordem precisa ser frame completo -> crop central -> crop ampliado");
  // Cada etapa retorna cedo (if (full) return full; / if (crop1) return crop1;) --
  // nunca roda a proxima escala se a anterior ja decodificou.
  assert.match(fn, /if \(full\) return full;/);
  assert.match(fn, /if \(crop1\) return crop1;/);
  // Crop ampliado usa um fator de escala > 1 (upscale de verdade, nao so um crop 1:1).
  assert.match(hook, /CENTER_CROP_ENLARGED_SCALE = 1\.8/);
});

test("intervalo de scan e limitado (throttle) pra nao explodir CPU com 3 sub-analises por tentativa", () => {
  assert.match(hook, /SCAN_INTERVAL_MS = 350/);
  assert.match(hook, /window\.setTimeout\(scan, SCAN_INTERVAL_MS\)/);
});

test("QrScanner (Turbo/pulseira) e QrScannerModal (fluxo principal) usam o MESMO hook -- nenhuma logica de decodificacao duplicada entre os dois", () => {
  assert.match(qrScanner, /import \{ useQrCameraScanner \} from '\.\/useQrCameraScanner'/);
  assert.match(qrScannerModal, /import \{ useQrCameraScanner \} from "\.\/useQrCameraScanner"/);
  assert.doesNotMatch(qrScanner, /BarcodeDetector/);
  assert.doesNotMatch(qrScannerModal, /BarcodeDetector/);
});

test("erros de camera sao classificados (permissao negada, sem camera, camera ocupada) em vez de uma mensagem generica unica", () => {
  const fn = slice(hook, "function describeCameraError", "const FULL_FRAME_TARGET_WIDTH");
  assert.match(fn, /NotAllowedError/);
  assert.match(fn, /NotFoundError/);
  assert.match(fn, /NotReadableError/);
  assert.match(fn, /Permissão de câmera negada/);
  assert.match(fn, /Nenhuma câmera encontrada/);
  assert.match(fn, /em uso por outro aplicativo/);
});

test("nenhuma nova deteccao/chamada de rede e agendada enquanto onRead ainda esta em andamento (evita chamadas duplicadas ao backend pro mesmo QR), e para imediatamente ao reconhecer um QR valido", () => {
  const scanFn = slice(hook, "const scan = async () => {", "timer = window.setTimeout(scan, 300);");
  const awaitIndex = scanFn.indexOf("await onReadRef.current(value)");
  const nextTimerIndex = scanFn.indexOf("if (!cancelled) timer = window.setTimeout(scan, SCAN_INTERVAL_MS);");
  assert.ok(awaitIndex !== -1 && nextTimerIndex !== -1 && awaitIndex < nextTimerIndex, "o proximo agendamento de scan precisa vir DEPOIS do await onRead, nunca em paralelo");
  assert.match(scanFn, /if \(value && value !== lastReadRef\.current\)/);
});

test("onRead e isolado via ref -- camera nunca reabre por causa de o componente-pai recriar a funcao onRead (bug real: WristbandLookupClient chamava setLoading(true) dentro do proprio handler, recriando a funcao e derrubando a camera no meio da leitura)", () => {
  assert.match(hook, /const onReadRef = useRef\(onRead\)/);
  assert.match(hook, /onReadRef\.current = onRead;/);
  const cameraEffect = slice(hook, "  useEffect(() => {\n    let cancelled = false;", "}, []);");
  assert.doesNotMatch(cameraEffect, /\[onRead\]/);
  assert.match(hook, /}, \[\]\);\s*\n\s*return \{ videoRef, status, message, lastDetectedAt \};/);
});

test("MediaStreamTracks sao liberadas no cleanup do effect (desmontar o componente, ou sair do Modo Turbo/trocar de tela, sempre libera a camera)", () => {
  const cleanup = slice(hook, "return () => {\n      cancelled = true;", "streamRef.current = null;\n    };");
  assert.match(cleanup, /cancelled = true/);
  assert.match(cleanup, /window\.clearTimeout\(timer\)/);
  assert.match(cleanup, /streamRef\.current\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
});

test("leitor USB/entrada manual continua existindo, mas como alternativa (Enter/botao), nunca como fluxo obrigatorio -- nenhum clique em 'fotografar' e exigido", () => {
  assert.match(qrScanner, /Leitor USB ou código manual/);
  assert.match(qrScannerModal, /Cole aqui o token ou link do QR Code/);
  assert.doesNotMatch(qrScanner, /fotografar|capturar foto/i);
});

test("QrScanner aceita guia visual central (guideLabel) e dica apos alguns segundos sem leitura (helpMessage) -- opcionais, usados pelo contexto de pulseira", () => {
  assert.match(qrScanner, /guideLabel\?:\s*string/);
  assert.match(qrScanner, /helpMessage\?:\s*string/);
  assert.match(qrScanner, /helpAfterMs/);
  assert.match(qrScanner, /lastDetectedAt/);
});
