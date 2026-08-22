import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF: alguns arquivos-fonte no ambiente Windows sao salvos
// com CRLF pelo editor independente do que a ferramenta escreveu; marcadores
// de slice() com \n literal precisam de LF puro pra bater.
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

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
  assert.match(detectFn, /return decodeWithJsQR\(canvas, context, video, wristbandMode\)/);
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
  const cameraEffect = slice(hook, "  useEffect(() => {\n    let cancelled = false;", "}, [wristbandMode]);");
  assert.doesNotMatch(cameraEffect, /\[onRead\]/);
  assert.match(hook, /}, \[wristbandMode\]\);\s*\n\s*return \{ videoRef, status, message, lastDetectedAt \};/);
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

test("guideLabel nunca fica desenhado por cima do video -- fica ACIMA da area da camera, e dentro do video sobra so a moldura de cantos, sem nenhum texto/caixa preenchida no centro", () => {
  const videoBlock = slice(qrScanner, "<video ref={videoRef}", "{helpMessage && showHelp");
  // O texto do guideLabel precisa aparecer ANTES do bloco do video (fora da
  // <div className="relative">), nunca dentro do overlay pointer-events-none
  // que fica sobreposto ao <video>.
  const guideLabelParagraphIdx = qrScanner.indexOf("{guideLabel ? <p ");
  const videoTagIdx = qrScanner.indexOf("<video ref={videoRef}");
  assert.ok(guideLabelParagraphIdx !== -1, "guideLabel precisa ser renderizado como paragrafo fora do video");
  assert.ok(guideLabelParagraphIdx < videoTagIdx, "o paragrafo do guideLabel precisa vir ANTES do <video>, nunca sobreposto a ele");
  // O overlay sobre o video (pointer-events-none) nao pode conter nenhum
  // texto/rotulo -- so os 4 cantos discretos (spans sem filhos de texto).
  assert.doesNotMatch(videoBlock, /\{guideLabel\}/);
  assert.doesNotMatch(videoBlock, /bg-slate-950\/70/);
  assert.match(videoBlock, /border-l-2 border-t-2/);
  assert.match(videoBlock, /border-r-2 border-t-2/);
  assert.match(videoBlock, /border-b-2 border-l-2/);
  assert.match(videoBlock, /border-b-2 border-r-2/);
});

test("modo pulseira (wristbandMode) e derivado do guideLabel e repassado pro hook -- QrScannerModal (sem guideLabel) nunca ativa o modo pulseira", () => {
  assert.match(qrScanner, /const wristbandMode = Boolean\(guideLabel\)/);
  assert.match(qrScanner, /useQrCameraScanner\(onRead, \{ wristbandMode \}\)/);
  assert.doesNotMatch(qrScannerModal, /wristbandMode/);
});

test("4a tentativa de crop (ainda mais agressiva) so roda no modo pulseira -- leitor comum de ingresso nunca paga esse custo extra de CPU quando as 3 primeiras falham", () => {
  const fn = slice(hook, "function decodeWithJsQR", "export function useQrCameraScanner");
  assert.match(fn, /if \(crop2 \|\| !wristbandMode\) return crop2;/);
  assert.match(hook, /CENTER_CROP_ULTRA_RATIO = 0\.16/);
  assert.match(hook, /CENTER_CROP_ULTRA_SCALE = 2\.4/);
});

test("zoom/foco continuo sao aplicados via applyConstraints DEPOIS que a camera ja abriu (nunca dentro do getUserMedia inicial), sempre com fallback silencioso -- nenhum 'exact' em nenhuma constraint de camera (comentarios explicando a regra nao contam)", () => {
  // Regex pega a CHAVE de constraint (`exact:` dentro de um objeto), nunca a
  // palavra dentro de comentario/prosa explicando por que ela e evitada.
  assert.doesNotMatch(hook, /\bexact\s*:/);
  assert.match(hook, /async function applyBestEffortTrackTuning\(track: MediaStreamTrack, wristbandMode: boolean\)/);
  const tuningFn = slice(hook, "async function applyBestEffortTrackTuning", "function decodeRegionWithJsQR");
  assert.match(tuningFn, /typeof track\.getCapabilities !== "function"/);
  assert.match(tuningFn, /try \{[\s\S]*?track\.getCapabilities\(\)/);
  assert.match(tuningFn, /await track\.applyConstraints\(\{ advanced \}\)/);
  assert.match(tuningFn, /catch \{/);
  // Zoom so entra no modo pulseira; foco continuo vale pros 2 modos.
  assert.match(tuningFn, /if \(wristbandMode && capabilities\.zoom/);
  const startFn = slice(hook, "async function start", "async function detectFromVideo");
  assert.match(startFn, /void applyBestEffortTrackTuning\(videoTrack, wristbandMode\)/);
});
