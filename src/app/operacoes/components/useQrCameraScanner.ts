"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { adaptiveThreshold, luminanceRange, stretchContrast } from "./qr-image-transforms";

// Leitura de QR por camera, compartilhada por QrScanner (Turbo + Ver
// pulseira vinculada) e QrScannerModal (fluxo principal da Central). Um so
// hook, um so lugar pra corrigir -- nenhum consumidor implementa sua propria
// logica de camera/decodificacao em paralelo.
//
// window.BarcodeDetector so existe hoje em Chrome/Edge no Android e
// ChromeOS por padrao -- em desktop a API nao existe sem flag experimental,
// entao a maioria das estacoes de operacao cai direto no fallback jsQR
// (biblioteca pura-JS, zero dependencias, madura) via canvas offscreen.
//
// Correcoes de leitura (QR de pulseira menor/mais distante que o de
// ingresso costumava falhar):
//   1. Pede resolucao de camera maior (ideal 1280x720) quando disponivel --
//      "ideal" nunca falha em camera que nao suporta, so usa o que der.
//   2. Nunca reduz cegamente pra 480px: o frame completo agora mira ate
//      640px de largura, e so reduz se a fonte for maior que isso.
//   3. Analise multi-escala por tentativa: frame completo -> crop central
//      (55%) -> crop central AMPLIADO (30% da area, desenhado ~1.8x maior
//      que o recorte original) -- da mais "pixels efetivos" pro jsQR quando
//      o QR real ocupa so uma fracao pequena do frame. Para no primeiro
//      sucesso, nunca faz as 3 tentativas se a primeira ja decodificou.
//
// Rodada 2 (audit de hardware mobile, hipotese "QR fisico pequeno"): 4a
// tentativa de crop (16%) SO no modo smallQrMode (antes chamado
// wristbandMode), mais zoom/foco best-effort via MediaTrackCapabilities.
// Corrigido tambem um bug real encontrado na auditoria: decodeRegionWithJsQR
// tinha o fator de upscale hardcoded com `Math.min(CENTER_CROP_ENLARGED_SCALE,
// targetWidth / sw)` -- 1.8x, pensado so pro passo do crop 30% -- aplicado a
// TODOS os passos, entao o passo do crop 16% nunca upscalava alem de 1.8x de
// verdade. Agora cada passo usa o proprio scale pretendido, com um teto de
// seguranca generico (MAX_SAFE_UPSCALE) so pra nunca gerar canvas gigante.
//
// RODADA 3 (esta) -- teste fisico real no iPhone comparando pulseiras de
// contraste diferente CONFIRMOU a causa raiz: nao e tamanho fisico, e
// CONTRASTE. O QR da pulseira e preto sobre rosa/roxo (marca do evento);
// o do ingresso e preto sobre branco. Auditoria com PNGs sinteticos (mesmo
// conteudo, so o fundo mudando) provou:
//   - Luminancia do fundo branco = 255; rosa (#EC4899) = ~130; roxo
//     (#A855F7) = ~128. Ou seja, o contraste "preto sobre marca" comeca com
//     quase METADE da margem do "preto sobre branco" antes de qualquer
//     degradacao real de camera (reflexo, pouca luz, compressao de video).
//   - Simulando degradacao progressiva: branco aguenta ate ~60-70% antes do
//     jsQR falhar; rosa/roxo falham ja em ~50%. E exatamente essa margem
//     menor que explica "aparece grande e nitido no preview, mas nao
//     decodifica" -- a tela do celular disfarca uma perda de contraste que
//     o pipeline de decodificacao (que opera sobre o frame cru da camera)
//     sente muito antes do olho humano.
//   - "Grayscale puro" testado e comprovado REDUNDANTE com RGB original --
//     jsQR ja calcula luminancia e faz sua propria binarizacao a partir do
//     RGB internamente, entao pre-converter pra grayscale nunca muda o
//     resultado (testado programaticamente, resultado identico em 100% dos
//     casos). Por isso NAO faz parte da cadeia abaixo -- seria custo puro,
//     zero ganho.
//   - Contraste esticado (normalizar o histograma de luminancia pro range
//     0-255) E threshold/binarizacao adaptativa (2-3 niveis, calculados a
//     partir do min/max de luminancia da PROPRIA regiao, nunca um valor
//     fixo que so funciona pra uma cor de fundo especifica) RECUPERAM
//     exatamente os casos que RGB simples perde: no ponto de degradacao
//     onde rosa/roxo falhavam (50%), TODAS as 2 tecnicas resolveram
//     sozinhas; com a cadeia completa, os 3 fundos (branco/rosa/roxo)
//     passaram a aguentar ate o limite testado (90%) sem diferenca entre
//     eles -- a cadeia fecha o gap de contraste.
//   - Testado tambem: cortar o frame em crops centrais pequenos (o caminho
//     da rodada 2) e CONTRAPRODUCENTE quando o QR ja preenche boa parte do
//     frame (exatamente o que a nossa propria instrucao na tela pede,
//     "aproxime ate ocupar boa parte da area") -- um crop de 9-16% nesse
//     cenario corta literalmente pela metade do padrao (miolo dos modulos),
//     nunca capturando os finder patterns inteiros. Por isso o passo "micro"
//     da rodada anterior foi REMOVIDO -- substituido pela cadeia de cor
//     abaixo, aplicada em regioes generosas o bastante pra sempre preservar
//     o QR inteiro + quiet zone.
//
// Estrategia atual, SO no modo smallQrMode (nunca no leitor comum de
// ingresso, que ja funciona bem e nao deve pagar nenhum custo extra):
//   1. Frame completo e o crop 55% (as 2 regioes que mais confiavelmente
//      preservam o QR inteiro + quiet zone, seja qual for a distancia)
//      ganham a CADEIA DE COR completa (ver decodeWithColorFallback):
//        a. RGB original, com jsQR attemptBoth (tenta as 2 polaridades
//           nativamente, sem custo de reprocessar pixel -- so uma opcao).
//        b. Contraste esticado.
//        c. Threshold adaptativo em 3 niveis (35%/50%/65% do range de
//           luminancia da propria regiao) -- nunca um numero fixo que so
//           serve pra uma cor de fundo.
//      Para no primeiro sucesso -- na pratica, a maioria das leituras
//      resolve no passo (a) ou (b), os thresholds so entram quando os 2
//      anteriores falham.
//   2. O crop 55% SO recebe a cadeia completa em ciclos alternados (metade
//      das tentativas usa so RGB simples ali) -- controla o custo extra de
//      CPU sem abrir mao da cobertura ao longo de ~2 ciclos (~700ms).
//   3. Crops 30%/16% (herdados da rodada 2) continuam SO RGB simples --
//      fallback pro caso raro do QR genuinamente pequeno/distante no frame,
//      sem empilhar mais custo em cima da cadeia de cor.
//   4. Zoom no modo smallQrMode voltou pra um valor mais conservador (35%
//      do range, era 60% na rodada 2 -- baseada na hipotese de distancia
//      que o teste fisico refutou). Zoom demais arrisca cortar o QR pra
//      fora do quadro, o que a causa real (contraste) nao precisa.
//   5. Torch (lanterna): NAO ligado automaticamente -- so a disponibilidade
//      da capability e reportada no overlay de debug, como preparo pra uma
//      decisao futura, sem nenhum codigo de producao novo.
//   6. Overlay de debug, SO em development (process.env.NODE_ENV ===
//      "development", eliminado do bundle de producao pelo Next.js em
//      tempo de build -- nunca aparece pro operador real): resolucao real
//      do video, qual crop/transformacao decodificou por ultimo e a escala
//      aplicada, mais um resumo de zoom/foco/torch.
export type QrCameraStatus = "starting" | "scanning" | "error";

export type QrCameraDebugInfo = {
  videoWidth: number;
  videoHeight: number;
  cropLabel: string;
  scale: number;
};

export type QrCameraTuningInfo = {
  zoomApplied: boolean;
  zoomValue: number | null;
  focusModeApplied: boolean;
  torchAvailable: boolean;
};

const NO_TUNING: QrCameraTuningInfo = { zoomApplied: false, zoomValue: null, focusModeApplied: false, torchAvailable: false };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
};

function getBarcodeDetector(): BarcodeDetectorLike | null {
  const Ctor = (
    window as unknown as {
      BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike;
    }
  ).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permissão de câmera negada. Autorize o acesso à câmera nas configurações do navegador.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Nenhuma câmera encontrada neste dispositivo.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "A câmera está em uso por outro aplicativo ou aba. Feche-o e tente novamente.";
  }
  if (name === "OverconstrainedError") {
    return "Nenhuma câmera compatível foi encontrada.";
  }
  return error instanceof Error ? error.message : "Não foi possível abrir a câmera.";
}

const FULL_FRAME_TARGET_WIDTH = 640;
const CENTER_CROP_RATIO = 0.55;
const CENTER_CROP_ENLARGED_RATIO = 0.3;
const CENTER_CROP_ENLARGED_SCALE = 1.8;
// SO no modo smallQrMode (custo de CPU restrito a esse contexto -- nunca no
// fluxo comum de ingresso, que ja acerta nas 2 primeiras tentativas). Ultimo
// nivel de crop mantido da rodada 2 -- fallback pro QR genuinamente pequeno/
// distante no frame, sem cadeia de cor em cima (ver comentario no topo).
const CENTER_CROP_ULTRA_RATIO = 0.16;
const CENTER_CROP_ULTRA_SCALE = 2.4;
// Niveis de threshold adaptativo (fracao do range min-max de luminancia da
// PROPRIA regiao, nunca um valor fixo de pixel) tentados em ordem na cadeia
// de cor -- ver decodeWithColorFallback.
const ADAPTIVE_THRESHOLD_FRACTIONS = [0.35, 0.5, 0.65];
// Range de luminancia abaixo do qual a regiao ja e uniforme demais (nada de
// contraste real pra esticar/binarizar) -- pula direto pros proximos
// fallbacks em vez de gastar CPU numa transformacao que nao muda nada.
const MIN_CONTRAST_RANGE = 10;
// Teto de seguranca generico pro upscale de qualquer passo -- bem acima do
// maior scale realmente usado, so existe pra nunca gerar um canvas gigante
// se sw vier anormalmente pequeno. Ver o bug de upscale limitado documentado
// no topo do arquivo: cada passo agora usa o PROPRIO scale pretendido em vez
// de um teto hardcoded pensado so pro passo do crop 30%.
const MAX_SAFE_UPSCALE = 6;
// Intervalo entre tentativas de deteccao. No modo smallQrMode, cada
// tentativa pode rodar varias sub-analises (multi-escala + cadeia de cor);
// 350ms mantem isso em ~3 ciclos/s -- responsivo sem virar um consumidor
// pesado de CPU.
const SCAN_INTERVAL_MS = 350;

// Capabilities/constraints experimentais (zoom, foco continuo) SEMPRE
// aplicadas via applyConstraints() DEPOIS que a camera ja abriu, nunca
// dentro do getUserMedia inicial -- e sempre com fallback silencioso (try/
// catch, checando a capability antes de usar). Isso garante que nenhum
// aparelho sem suporte a essas APIs deixe de abrir a camera: na pior
// hipotese, o ajuste extra simplesmente nao acontece.
type ExtendedTrackCapabilities = MediaTrackCapabilities & {
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
  torch?: boolean;
};
type ExtendedTrackConstraintSet = MediaTrackConstraintSet & { zoom?: number; focusMode?: string };

async function applyBestEffortTrackTuning(track: MediaStreamTrack, smallQrMode: boolean): Promise<QrCameraTuningInfo> {
  if (typeof track.getCapabilities !== "function") return NO_TUNING;
  let capabilities: ExtendedTrackCapabilities;
  try {
    capabilities = track.getCapabilities() as ExtendedTrackCapabilities;
  } catch {
    return NO_TUNING;
  }

  // Torch NUNCA e ligado automaticamente aqui -- so reportamos se o
  // dispositivo anuncia a capability, pro overlay de debug (dev-only). Fica
  // pronto pra uma decisao futura, sem nenhum codigo de producao novo.
  const torchAvailable = Boolean(capabilities.torch);

  const advanced: ExtendedTrackConstraintSet[] = [];
  let wantsFocusMode = false;
  let zoomTarget: number | null = null;

  // Foco continuo ajuda tanto ingresso quanto pulseira -- pedido sempre que
  // o dispositivo anuncia suporte, nunca como "exact" (constraint que
  // rejeitaria a camera inteira em quem nao suporta).
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
    wantsFocusMode = true;
  }

  // Zoom moderado (35% do range acima do minimo, nunca o maximo) SO no modo
  // smallQrMode. Era 60% na rodada anterior, baseado na hipotese de que o
  // problema era distancia/tamanho fisico -- o teste real no iPhone
  // confirmou que a causa e CONTRASTE, nao tamanho, entao zoom agressivo
  // nao ajuda a causa real e so aumenta o risco de cortar o QR pra fora do
  // quadro. Mantido moderado, so como reforço leve pro caso de QR
  // genuinamente pequeno no frame.
  if (smallQrMode && capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max) && capabilities.zoom.max > capabilities.zoom.min) {
    const { min, max } = capabilities.zoom;
    zoomTarget = min + (max - min) * 0.35;
    advanced.push({ zoom: zoomTarget });
  }

  if (advanced.length === 0) return { zoomApplied: false, zoomValue: null, focusModeApplied: false, torchAvailable };
  try {
    await track.applyConstraints({ advanced });
    return { zoomApplied: zoomTarget !== null, zoomValue: zoomTarget, focusModeApplied: wantsFocusMode, torchAvailable };
  } catch {
    // Suporte anunciado mas aplicacao falhou (ou navegador inconsistente) --
    // segue com a camera exatamente como abriu, nunca bloqueia o scanner.
    // Reportado como NAO aplicado (honesto no debug: capability existe mas
    // nao pegou), nunca como sucesso.
    return { zoomApplied: false, zoomValue: null, focusModeApplied: false, torchAvailable };
  }
}

function decodeImageData(data: Uint8ClampedArray, width: number, height: number, invertOpt: "dontInvert" | "attemptBoth"): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: invertOpt });
  return result?.data?.trim() || null;
}

/**
 * Desenha a regiao no canvas e tenta decodificar com a cadeia de cor
 * completa, parando no primeiro sucesso: RGB (com jsQR attemptBoth, que
 * tenta as 2 polaridades nativamente sem custo de reprocessar pixel) ->
 * contraste esticado -> ate 3 thresholds adaptativos. Preserva SEMPRE a
 * regiao inteira desenhada (nunca recorta mais fundo em cima do crop
 * recebido) -- as transformacoes mexem em COR, nunca em enquadramento.
 */
function decodeWithColorFallback(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  targetWidth: number,
  cropLabel: string,
  onAttempt?: (info: QrCameraDebugInfo) => void,
): string | null {
  if (sw <= 0 || sh <= 0) return null;
  // Mesmo scale pretendido de sempre (ver bug documentado no topo do
  // arquivo) -- upscale, nunca downscale alem do necessario.
  const scale = Math.min(MAX_SAFE_UPSCALE, targetWidth / sw) || 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  canvas.width = dw;
  canvas.height = dh;
  context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
  const imageData = context.getImageData(0, 0, dw, dh);
  const report = (transform: string) => onAttempt?.({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, cropLabel: `${cropLabel} · ${transform}`, scale: Math.round(scale * 100) / 100 });

  const plain = decodeImageData(imageData.data, dw, dh, "attemptBoth");
  if (plain) {
    report("RGB");
    return plain;
  }

  const { min, max } = luminanceRange(imageData.data);
  if (max - min < MIN_CONTRAST_RANGE) {
    // Regiao uniforme demais (sem contraste real pra explorar) -- nenhuma
    // das transformacoes abaixo mudaria o resultado, pula direto.
    report("RGB (sem contraste suficiente pra binarizar)");
    return null;
  }

  const contrasted = decodeImageData(stretchContrast(imageData.data, min, max), dw, dh, "dontInvert");
  if (contrasted) {
    report("contraste");
    return contrasted;
  }

  for (const fraction of ADAPTIVE_THRESHOLD_FRACTIONS) {
    const binarized = decodeImageData(adaptiveThreshold(imageData.data, min, max, fraction), dw, dh, "dontInvert");
    if (binarized) {
      report(`limiar ${Math.round(fraction * 100)}%`);
      return binarized;
    }
  }

  report("nenhuma transformacao decodificou");
  return null;
}

function decodeRegionWithJsQR(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  targetWidth: number,
  cropLabel: string,
  onAttempt?: (info: QrCameraDebugInfo) => void,
): string | null {
  if (sw <= 0 || sh <= 0) return null;
  const scale = Math.min(MAX_SAFE_UPSCALE, targetWidth / sw) || 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  canvas.width = dw;
  canvas.height = dh;
  context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
  onAttempt?.({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, cropLabel, scale: Math.round(scale * 100) / 100 });
  const imageData = context.getImageData(0, 0, dw, dh);
  return decodeImageData(imageData.data, dw, dh, "dontInvert");
}

function decodeWithJsQR(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  smallQrMode: boolean,
  allowColorChainOnCrop: boolean,
  onAttempt?: (info: QrCameraDebugInfo) => void,
): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  if (!smallQrMode) {
    // Leitor comum de ingresso -- inalterado, sem cadeia de cor (custo extra
    // restrito ao modo pulseira).
    const full = decodeRegionWithJsQR(canvas, context, video, 0, 0, vw, vh, FULL_FRAME_TARGET_WIDTH, "full", onAttempt);
    if (full) return full;
    const cw1 = vw * CENTER_CROP_RATIO;
    const ch1 = vh * CENTER_CROP_RATIO;
    const crop1 = decodeRegionWithJsQR(canvas, context, video, (vw - cw1) / 2, (vh - ch1) / 2, cw1, ch1, FULL_FRAME_TARGET_WIDTH, "55%", onAttempt);
    if (crop1) return crop1;
    const cw2 = vw * CENTER_CROP_ENLARGED_RATIO;
    const ch2 = vh * CENTER_CROP_ENLARGED_RATIO;
    return decodeRegionWithJsQR(canvas, context, video, (vw - cw2) / 2, (vh - ch2) / 2, cw2, ch2, Math.round(cw2 * CENTER_CROP_ENLARGED_SCALE), "30%", onAttempt);
  }

  // 1. Frame completo -- SEMPRE com a cadeia de cor completa. E a regiao
  //    que mais confiavelmente preserva o QR inteiro + quiet zone, seja
  //    qual for a distancia da pulseira -- por isso e o principal alvo da
  //    correcao de contraste (ver auditoria no topo do arquivo).
  const full = decodeWithColorFallback(canvas, context, video, 0, 0, vw, vh, FULL_FRAME_TARGET_WIDTH, "full", onAttempt);
  if (full) return full;

  // 2. Crop 55% -- ainda generoso o bastante pra preservar o QR inteiro na
  //    maioria dos enquadramentos. SO recebe a cadeia de cor completa em
  //    ciclos alternados (allowColorChainOnCrop) -- controla o custo extra
  //    de CPU sem abrir mao da cobertura ao longo de ~2 ciclos (~700ms).
  const cw1 = vw * CENTER_CROP_RATIO;
  const ch1 = vh * CENTER_CROP_RATIO;
  const crop1 = allowColorChainOnCrop
    ? decodeWithColorFallback(canvas, context, video, (vw - cw1) / 2, (vh - ch1) / 2, cw1, ch1, FULL_FRAME_TARGET_WIDTH, "55%", onAttempt)
    : decodeRegionWithJsQR(canvas, context, video, (vw - cw1) / 2, (vh - ch1) / 2, cw1, ch1, FULL_FRAME_TARGET_WIDTH, "55%", onAttempt);
  if (crop1) return crop1;

  // 3. Crops 30%/16% -- herdados da rodada anterior, SO RGB simples (sem
  //    cadeia de cor): fallback pro caso raro do QR genuinamente pequeno/
  //    distante no frame. Regioes pequenas demais pra garantir margem ao
  //    redor do QR quando ele preenche boa parte do quadro -- por isso NAO
  //    ganham a cadeia de cor (a correcao de contraste precisa do QR
  //    inteiro + quiet zone, nao de um recorte que pode cortar o padrao).
  const cw2 = vw * CENTER_CROP_ENLARGED_RATIO;
  const ch2 = vh * CENTER_CROP_ENLARGED_RATIO;
  const crop2 = decodeRegionWithJsQR(
    canvas,
    context,
    video,
    (vw - cw2) / 2,
    (vh - ch2) / 2,
    cw2,
    ch2,
    Math.round(cw2 * CENTER_CROP_ENLARGED_SCALE),
    "30%",
    onAttempt,
  );
  if (crop2) return crop2;

  const cw3 = vw * CENTER_CROP_ULTRA_RATIO;
  const ch3 = vh * CENTER_CROP_ULTRA_RATIO;
  return decodeRegionWithJsQR(
    canvas,
    context,
    video,
    (vw - cw3) / 2,
    (vh - ch3) / 2,
    cw3,
    ch3,
    Math.round(cw3 * CENTER_CROP_ULTRA_SCALE),
    "16%",
    onAttempt,
  );
}

export function useQrCameraScanner(
  onRead: (value: string) => Promise<void>,
  options?: { smallQrMode?: boolean },
) {
  const smallQrMode = options?.smallQrMode ?? false;
  const isDev = process.env.NODE_ENV === "development";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastReadRef = useRef<string>("");
  // onRead muda de referencia a cada render do componente-pai que nao
  // memoiza o callback (ex.: WristbandLookupClient chama setLoading(true)
  // no proprio inicio do handler, o que re-renderiza e recria a funcao
  // ANTES do await terminar). Sem isolar via ref, o useEffect abaixo
  // (se dependesse de onRead) desmontaria e reabriria a camera no meio de
  // uma leitura em andamento -- exatamente o bug que fazia a pulseira
  // "nao ser reconhecida" em /operacoes/pulseira. A camera agora abre uma
  // unica vez por montagem; o loop de scan sempre chama a versao mais
  // recente de onRead through this ref, nunca precisa reabrir a camera por
  // causa disso.
  const onReadRef = useRef(onRead);
  const [status, setStatus] = useState<QrCameraStatus>("starting");
  const [message, setMessage] = useState("Abrindo câmera...");
  const [lastDetectedAt, setLastDetectedAt] = useState<number | null>(null);
  // SO povoados em development (ver isDev acima) -- nunca em producao. Uma
  // funcao de update fica bem mais barata pra chamar de dentro do loop de
  // scan quando esta desativada: no-op literal, nenhuma alocacao de objeto.
  const [debugInfo, setDebugInfo] = useState<QrCameraDebugInfo | null>(null);
  const [tuningInfo, setTuningInfo] = useState<QrCameraTuningInfo | null>(null);

  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let scanTick = 0;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const [videoTrack] = stream.getVideoTracks();
        const tuning = videoTrack ? await applyBestEffortTrackTuning(videoTrack, smallQrMode) : NO_TUNING;
        if (isDev) setTuningInfo(tuning);

        const detector = getBarcodeDetector();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const onAttempt = isDev ? (info: QrCameraDebugInfo) => setDebugInfo(info) : undefined;

        async function detectFromVideo(allowColorChainOnCrop: boolean): Promise<string | null> {
          const video = videoRef.current;
          if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return null;

          if (detector) {
            try {
              const codes = await detector.detect(video);
              onAttempt?.({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, cropLabel: "nativo (BarcodeDetector)", scale: 1 });
              return codes[0]?.rawValue?.trim() || null;
            } catch {
              return null;
            }
          }

          if (!context) return null;
          return decodeWithJsQR(canvas, context, video, smallQrMode, allowColorChainOnCrop, onAttempt);
        }

        if (cancelled) return;
        setStatus("scanning");
        setMessage("Aponte a câmera para o QR Code.");

        const scan = async () => {
          if (cancelled) return;
          // Cadeia de cor completa no crop 55% (alem do frame completo, que
          // sempre recebe) alternada por ciclo -- ver comentario no topo do
          // arquivo. Metade das tentativas fica so com RGB simples ali,
          // controlando o custo extra de CPU sem abrir mao da cobertura ao
          // longo de ~2 ciclos (~700ms).
          const allowColorChainOnCrop = smallQrMode && scanTick % 2 === 0;
          scanTick += 1;
          try {
            const value = await detectFromVideo(allowColorChainOnCrop);
            // So processa um QR novo -- enquanto o mesmo codigo continuar
            // visivel (operador ainda nao afastou a camera), ignora; e
            // enquanto onRead nao resolver, nenhuma nova varredura e
            // agendada (proximo setTimeout so roda depois do await abaixo)
            // -- para imediatamente ao reconhecer, nunca dispara leitura
            // duplicada em paralelo.
            if (value && value !== lastReadRef.current) {
              lastReadRef.current = value;
              setMessage("QR Code localizado.");
              setLastDetectedAt(Date.now());
              await onReadRef.current(value);
              if (!cancelled) {
                setMessage("Aponte a câmera para o QR Code.");
                window.setTimeout(() => {
                  lastReadRef.current = "";
                }, 1200);
              }
            }
          } catch {
            // Mantem tentando enquanto a camera estiver aberta.
          }
          if (!cancelled) timer = window.setTimeout(scan, SCAN_INTERVAL_MS);
        };

        timer = window.setTimeout(scan, 300);
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setMessage(describeCameraError(error));
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // Deliberadamente SEM onRead nas deps -- ver comentario no onReadRef
    // acima. A camera so deve abrir/fechar por causa da montagem/
    // desmontagem do componente, nunca por troca de identidade de funcao.
    // smallQrMode/isDev entram pq sao lidos dentro do efeito, mas na pratica
    // sao estaticos por montagem -- nenhum consumidor troca esses valores no
    // meio da vida do componente.
  }, [smallQrMode, isDev]);

  return { videoRef, status, message, lastDetectedAt, debugInfo, tuningInfo };
}
