"use client";

import { useEffect, useRef, useState } from "react";

export function QrScannerModal({
  onClose,
  onRead,
}: {
  onClose: () => void;
  onRead: (value: string) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [scannerMessage, setScannerMessage] = useState("Aponte a câmera para o QR Code.");

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
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

        const Detector = (
          window as unknown as {
            BarcodeDetector?: new (options: { formats: string[] }) => {
              detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
            };
          }
        ).BarcodeDetector;

        if (!Detector) {
          setScannerMessage("Leitura automática não disponível neste navegador. Cole o conteúdo do QR abaixo.");
          return;
        }

        const detector = new Detector({ formats: ["qr_code"] });

        const scan = async () => {
          if (cancelled || !videoRef.current) return;

          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue;

            if (value) {
              setScannerMessage("QR Code localizado.");
              await onRead(value);
              return;
            }
          } catch {
            // Continua tentando enquanto a câmera estiver aberta.
          }

          timer = window.setTimeout(scan, 350);
        };

        timer = window.setTimeout(scan, 500);
      } catch (error) {
        setScannerMessage(
          error instanceof Error
            ? error.message
            : "Não foi possível abrir a câmera.",
        );
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [onRead]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div className="w-full max-w-xl rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">Ler QR Code</h2>
            <p className="text-sm text-slate-400">{scannerMessage}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-3 py-2 text-sm"
          >
            Fechar
          </button>
        </div>

        <video
          ref={videoRef}
          playsInline
          muted
          className="mt-4 aspect-video w-full rounded-2xl bg-black object-cover"
        />

        <div className="mt-4 flex gap-2">
          <input
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
            placeholder="Cole aqui o token ou link do QR Code"
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void onRead(manualValue)}
            disabled={!manualValue.trim()}
            className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            Localizar
          </button>
        </div>
      </div>
    </div>
  );
}
