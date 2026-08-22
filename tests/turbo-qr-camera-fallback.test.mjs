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
const colorTransforms = await readFile(new URL("../src/app/operacoes/components/qr-image-transforms.ts", import.meta.url), "utf8");
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

test("hook decodifica com BarcodeDetector quando disponivel, e cai pra jsQR via canvas quando nao existir", () => {
  assert.match(hook, /import jsQR from "jsqr"/);
  assert.match(hook, /function getBarcodeDetector\(\)/);
  assert.match(hook, /window\.BarcodeDetector/);
  const detectFn = slice(hook, "async function detectFromVideo", "if (cancelled) return;\n        setStatus");
  assert.match(detectFn, /if \(detector\) \{/);
  assert.match(detectFn, /return decodeWithJsQR\(canvas, context, video, smallQrMode, allowColorChainOnCrop, onAttempt\)/);
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

test("leitor comum de ingresso (!smallQrMode): frame completo -> crop 55% -> crop 30%, SEM cadeia de cor, parando no primeiro sucesso", () => {
  const fn = slice(hook, "function decodeWithJsQR", "export function useQrCameraScanner");
  const genericPath = slice(fn, "if (!smallQrMode) {", "// 1. Frame completo -- SEMPRE");
  assert.match(genericPath, /decodeRegionWithJsQR\(canvas, context, video, 0, 0, vw, vh, FULL_FRAME_TARGET_WIDTH, "full", onAttempt\)/);
  assert.match(genericPath, /if \(full\) return full;/);
  assert.match(genericPath, /CENTER_CROP_RATIO/);
  assert.match(genericPath, /if \(crop1\) return crop1;/);
  assert.match(genericPath, /CENTER_CROP_ENLARGED_RATIO/);
  // O caminho generico usa decodeRegionWithJsQR (RGB simples), NUNCA
  // decodeWithColorFallback -- custo extra restrito ao modo smallQrMode.
  assert.doesNotMatch(genericPath, /decodeWithColorFallback/);
  assert.match(hook, /CENTER_CROP_ENLARGED_SCALE = 1\.8/);
});

test("intervalo de scan e limitado (throttle) pra nao explodir CPU", () => {
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
  const cameraEffect = slice(hook, "  useEffect(() => {\n    let cancelled = false;", "}, [smallQrMode, isDev]);");
  assert.doesNotMatch(cameraEffect, /\[onRead\]/);
  assert.match(hook, /}, \[smallQrMode, isDev\]\);\s*\n\s*\n\s*return \{ videoRef, status, message, lastDetectedAt, debugInfo, tuningInfo \};/);
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
  const guideLabelParagraphIdx = qrScanner.indexOf("{guideLabel ? <p ");
  const videoTagIdx = qrScanner.indexOf("<video ref={videoRef}");
  assert.ok(guideLabelParagraphIdx !== -1, "guideLabel precisa ser renderizado como paragrafo fora do video");
  assert.ok(guideLabelParagraphIdx < videoTagIdx, "o paragrafo do guideLabel precisa vir ANTES do <video>, nunca sobreposto a ele");
  assert.doesNotMatch(videoBlock, /\{guideLabel\}/);
  assert.doesNotMatch(videoBlock, /bg-slate-950\/70/);
  assert.match(videoBlock, /border-l-2 border-t-2/);
  assert.match(videoBlock, /border-r-2 border-t-2/);
  assert.match(videoBlock, /border-b-2 border-l-2/);
  assert.match(videoBlock, /border-b-2 border-r-2/);
});

test("modo smallQrMode e derivado do guideLabel e repassado pro hook -- QrScannerModal (sem guideLabel) nunca ativa esse modo", () => {
  assert.match(qrScanner, /const smallQrMode = Boolean\(guideLabel\)/);
  assert.match(qrScanner, /useQrCameraScanner\(onRead, \{ smallQrMode \}\)/);
  assert.doesNotMatch(qrScannerModal, /smallQrMode/);
});

test("causa raiz documentada no codigo: contraste (preto sobre rosa/roxo tem so ~metade da luminancia de preto sobre branco), nao tamanho fisico -- confirmada por teste real no iPhone", () => {
  assert.match(hook, /CONTRASTE/);
  assert.match(hook, /preto sobre rosa\/roxo|preto sobre marca/);
  assert.match(hook, /255.*rosa.*130|130.*255/is);
  assert.match(hook, /teste fisico real no iPhone/);
});

test("grayscale puro NAO faz parte da cadeia de cor -- testado e comprovado redundante com RGB (jsQR ja binariza a partir do RGB internamente)", () => {
  assert.match(hook, /grayscale.*redundante|redundante.*grayscale/is);
  assert.doesNotMatch(colorTransforms, /function grayscale/);
});

test("cadeia de cor (decodeWithColorFallback) tenta, em ordem, parando no primeiro sucesso: RGB com attemptBoth -> contraste esticado -> ate 3 thresholds adaptativos", () => {
  const fn = slice(hook, "function decodeWithColorFallback", "function decodeRegionWithJsQR");
  const plainIdx = fn.indexOf('decodeImageData(imageData.data, dw, dh, "attemptBoth")');
  const contrastIdx = fn.indexOf("stretchContrast(imageData.data, min, max)");
  const thresholdIdx = fn.indexOf("for (const fraction of ADAPTIVE_THRESHOLD_FRACTIONS)");
  assert.ok(plainIdx !== -1 && contrastIdx !== -1 && thresholdIdx !== -1, "as 3 etapas da cadeia de cor precisam existir");
  assert.ok(plainIdx < contrastIdx && contrastIdx < thresholdIdx, "ordem precisa ser RGB -> contraste -> thresholds");
  assert.match(fn, /if \(plain\) \{[\s\S]*?return plain;/);
  assert.match(fn, /if \(contrasted\) \{[\s\S]*?return contrasted;/);
  assert.match(fn, /if \(binarized\) \{[\s\S]*?return binarized;/);
  assert.match(hook, /ADAPTIVE_THRESHOLD_FRACTIONS = \[0\.35, 0\.5, 0\.65\]/);
});

test("cadeia de cor pula contraste/threshold quando a regiao ja e uniforme demais (MIN_CONTRAST_RANGE) -- nao gasta CPU numa transformacao que nao muda nada", () => {
  assert.match(hook, /MIN_CONTRAST_RANGE = 10/);
  const fn = slice(hook, "function decodeWithColorFallback", "function decodeRegionWithJsQR");
  assert.match(fn, /if \(max - min < MIN_CONTRAST_RANGE\)/);
});

test("cadeia de cor SO roda no modo smallQrMode, e SO no frame completo (sempre) e no crop 55% (alternado por ciclo) -- crops 30%/16% ficam RGB simples, ticket scanning nunca paga o custo extra", () => {
  const fn = slice(hook, "function decodeWithJsQR", "export function useQrCameraScanner");
  assert.match(fn, /decodeWithColorFallback\(canvas, context, video, 0, 0, vw, vh, FULL_FRAME_TARGET_WIDTH, "full", onAttempt\)/);
  assert.match(fn, /const crop1 = allowColorChainOnCrop\s*\n\s*\? decodeWithColorFallback/);
  assert.match(fn, /: decodeRegionWithJsQR\(canvas, context, video, \(vw - cw1\) \/ 2/);
  // 30%/16%: sempre decodeRegionWithJsQR (RGB simples), nunca decodeWithColorFallback.
  const crop2AndBeyond = slice(fn, "// 3. Crops 30%/16%", null);
  assert.doesNotMatch(crop2AndBeyond, /decodeWithColorFallback/);
});

test("passo 'micro' da rodada anterior foi removido -- substituido pela cadeia de cor (nao existe mais crop de 9% nem contrast-retry proprio)", () => {
  assert.doesNotMatch(hook, /CENTER_CROP_MICRO_RATIO/);
  assert.doesNotMatch(hook, /decodeMicroCropWithContrastRetry/);
});

test("crops 30%/16% (fallback pro QR pequeno/distante) continuam existindo, herdados da rodada anterior", () => {
  assert.match(hook, /CENTER_CROP_ULTRA_RATIO = 0\.16/);
  assert.match(hook, /CENTER_CROP_ULTRA_SCALE = 2\.4/);
});

test("transformacoes de pixel (contraste/threshold) moram num modulo separado sem DOM -- testavel direto, nao redefinidas dentro do hook", () => {
  assert.match(hook, /import \{ adaptiveThreshold, luminanceRange, stretchContrast \} from "\.\/qr-image-transforms"/);
  assert.match(colorTransforms, /export function luminanceRange/);
  assert.match(colorTransforms, /export function stretchContrast/);
  assert.match(colorTransforms, /export function adaptiveThreshold/);
});

test("zoom no modo smallQrMode e moderado (35% do range, nunca o maximo) -- reduzido da rodada anterior (60%) apos o teste real confirmar que a causa e contraste, nao distancia", () => {
  const tuningFn = slice(hook, "async function applyBestEffortTrackTuning", "function decodeImageData");
  assert.match(tuningFn, /zoomTarget = min \+ \(max - min\) \* 0\.35/);
  assert.doesNotMatch(tuningFn, /\* 0\.6\b/);
  // Zoom so entra no modo smallQrMode; foco continuo vale pros 2 modos.
  assert.match(tuningFn, /if \(smallQrMode && capabilities\.zoom/);
});

test("torch (lanterna) NUNCA e ligado automaticamente -- so a disponibilidade da capability e reportada (preparo pra decisao futura, nenhum codigo de producao novo)", () => {
  const tuningFn = slice(hook, "async function applyBestEffortTrackTuning", "function decodeImageData");
  assert.match(tuningFn, /const torchAvailable = Boolean\(capabilities\.torch\)/);
  assert.doesNotMatch(tuningFn, /applyConstraints\([^)]*torch/s);
  assert.doesNotMatch(hook, /\btrack\.torch\s*=/);
});

test("zoom/foco sao aplicados via applyConstraints DEPOIS que a camera ja abriu (nunca dentro do getUserMedia inicial), sempre com fallback silencioso -- nenhum 'exact' em nenhuma constraint de camera (comentarios explicando a regra nao contam)", () => {
  // Regex pega a CHAVE de constraint (`exact:` dentro de um objeto), nunca a
  // palavra dentro de comentario/prosa explicando por que ela e evitada.
  assert.doesNotMatch(hook, /\bexact\s*:/);
  assert.match(hook, /async function applyBestEffortTrackTuning\(track: MediaStreamTrack, smallQrMode: boolean\)/);
  const tuningFn = slice(hook, "async function applyBestEffortTrackTuning", "function decodeImageData");
  assert.match(tuningFn, /typeof track\.getCapabilities !== "function"/);
  assert.match(tuningFn, /try \{[\s\S]*?track\.getCapabilities\(\)/);
  assert.match(tuningFn, /await track\.applyConstraints\(\{ advanced \}\)/);
  assert.match(tuningFn, /catch \{/);
  const startFn = slice(hook, "async function start", "async function detectFromVideo");
  assert.match(startFn, /await applyBestEffortTrackTuning\(videoTrack, smallQrMode\)/);
});

test("overlay de medicao (resolucao/crop/escala/zoom/foco/torch) SO existe em development -- eliminado do bundle de producao", () => {
  assert.match(hook, /process\.env\.NODE_ENV === "development"/);
  assert.match(hook, /QrCameraDebugInfo/);
  assert.match(hook, /QrCameraTuningInfo/);
  assert.match(qrScanner, /process\.env\.NODE_ENV === 'development'/);
  const overlay = slice(qrScanner, "process.env.NODE_ENV === 'development' && guideLabel", "{helpMessage && showHelp ? (");
  assert.match(overlay, /debugInfo\.videoWidth/);
  assert.match(overlay, /debugInfo\.cropLabel/);
  assert.match(overlay, /tuningInfo\.zoomApplied/);
  assert.match(overlay, /tuningInfo\.torchAvailable/);
});
