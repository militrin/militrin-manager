"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

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
// Auditoria de hardware mobile real (QR de pulseira ainda dificil no
// iPhone): melhorias adicionais, todas restritas ao "modo pulseira"
// (options.wristbandMode) pra nao custar CPU extra no leitor comum de
// ingresso, que ja funciona bem:
//   4. Quarta tentativa de crop, ainda mais agressiva (16% da area, upscale
//      2.4x) -- ver decodeWithJsQR passo 4.
//   5. Zoom moderado (25% do range acima do minimo) via
//      MediaTrackCapabilities/applyConstraints, quando o navegador anuncia
//      suporte -- ver applyBestEffortTrackTuning. Foco continuo (quando
//      suportado) e pedido pros 2 modos, nao so pulseira.
//   Nenhuma dessas 2 usa "exact": sempre aplicadas via applyConstraints()
//   best-effort DEPOIS que a camera ja abriu, nunca dentro do getUserMedia
//   inicial -- um aparelho sem suporte simplesmente nao recebe o ajuste
//   extra, a camera nunca deixa de abrir por causa disso.
export type QrCameraStatus = "starting" | "scanning" | "error";

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
// Tentativa extra, SO no modo pulseira (custo de CPU restrito a esse
// contexto -- nunca no fluxo comum de ingresso, que ja acerta nas 3
// primeiras tentativas): recorte ainda mais agressivo, upscale maior, pro
// caso do QR ocupar so uma fracao minima do quadro.
const CENTER_CROP_ULTRA_RATIO = 0.16;
const CENTER_CROP_ULTRA_SCALE = 2.4;
// Intervalo entre tentativas de deteccao. Cada tentativa (no fallback jsQR)
// pode rodar ate 3 sub-analises (multi-escala); 350ms mantem isso em ~3
// ciclos/s -- responsivo sem virar um consumidor pesado de CPU.
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
};
type ExtendedTrackConstraintSet = MediaTrackConstraintSet & { zoom?: number; focusMode?: string };

async function applyBestEffortTrackTuning(track: MediaStreamTrack, wristbandMode: boolean) {
  if (typeof track.getCapabilities !== "function") return;
  let capabilities: ExtendedTrackCapabilities;
  try {
    capabilities = track.getCapabilities() as ExtendedTrackCapabilities;
  } catch {
    return;
  }

  const advanced: ExtendedTrackConstraintSet[] = [];

  // Foco continuo ajuda tanto ingresso quanto pulseira -- pedido sempre que
  // o dispositivo anuncia suporte, nunca como "exact" (constraint que
  // rejeitaria a camera inteira em quem nao suporta).
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }

  // Zoom moderado (25% do range acima do minimo, nunca o maximo -- perderia
  // campo de visao) SO no modo pulseira: QR pequeno/distante e o caso que
  // pediu essa melhoria; no leitor de ingresso comum o zoom padrao ja
  // funciona bem e mexer nele so adicionaria risco.
  if (wristbandMode && capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max) && capabilities.zoom.max > capabilities.zoom.min) {
    const { min, max } = capabilities.zoom;
    advanced.push({ zoom: min + (max - min) * 0.25 });
  }

  if (advanced.length === 0) return;
  try {
    await track.applyConstraints({ advanced });
  } catch {
    // Suporte anunciado mas aplicacao falhou (ou navegador inconsistente) --
    // segue com a camera exatamente como abriu, nunca bloqueia o scanner.
  }
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
): string | null {
  if (sw <= 0 || sh <= 0) return null;
  const scale = Math.min(CENTER_CROP_ENLARGED_SCALE, targetWidth / sw) || 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  canvas.width = dw;
  canvas.height = dh;
  context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
  const imageData = context.getImageData(0, 0, dw, dh);
  const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
  return result?.data?.trim() || null;
}

function decodeWithJsQR(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, video: HTMLVideoElement, wristbandMode: boolean): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  // 1. Frame completo -- pega QR grande/medio bem enquadrado (ingresso).
  const full = decodeRegionWithJsQR(canvas, context, video, 0, 0, vw, vh, FULL_FRAME_TARGET_WIDTH);
  if (full) return full;

  // 2. Crop central -- descarta a margem, entao o QR (normalmente perto do
  //    centro) ocupa uma fracao maior do quadro analisado.
  const cw1 = vw * CENTER_CROP_RATIO;
  const ch1 = vh * CENTER_CROP_RATIO;
  const crop1 = decodeRegionWithJsQR(canvas, context, video, (vw - cw1) / 2, (vh - ch1) / 2, cw1, ch1, FULL_FRAME_TARGET_WIDTH);
  if (crop1) return crop1;

  // 3. Crop central AMPLIADO -- regiao ainda menor, desenhada em escala
  //    maior que a original (upscale). Ajuda especificamente QR pequeno
  //    e distante (tipico de pulseira), quando nem o crop 55% da
  //    resolucao suficiente.
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
  );
  if (crop2 || !wristbandMode) return crop2;

  // 4. Crop central ULTRA agressivo -- SO no modo pulseira (custo extra de
  //    CPU restrito a esse contexto). Regiao ainda menor que a do passo 3,
  //    com upscale maior, pro caso do QR da pulseira ocupar uma fracao
  //    minima do quadro mesmo apos os 3 passos anteriores falharem.
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
  );
}

export function useQrCameraScanner(
  onRead: (value: string) => Promise<void>,
  options?: { wristbandMode?: boolean },
) {
  const wristbandMode = options?.wristbandMode ?? false;
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

  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

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
        if (videoTrack) void applyBestEffortTrackTuning(videoTrack, wristbandMode);

        const detector = getBarcodeDetector();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });

        async function detectFromVideo(): Promise<string | null> {
          const video = videoRef.current;
          if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return null;

          if (detector) {
            try {
              const codes = await detector.detect(video);
              return codes[0]?.rawValue?.trim() || null;
            } catch {
              return null;
            }
          }

          if (!context) return null;
          return decodeWithJsQR(canvas, context, video, wristbandMode);
        }

        if (cancelled) return;
        setStatus("scanning");
        setMessage("Aponte a câmera para o QR Code.");

        const scan = async () => {
          if (cancelled) return;
          try {
            const value = await detectFromVideo();
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
    // wristbandMode entra pq e lido dentro do efeito (decode + tuning), mas
    // na pratica e estatico por montagem -- nenhum consumidor troca esse
    // valor no meio da vida do componente.
  }, [wristbandMode]);

  return { videoRef, status, message, lastDetectedAt };
}
