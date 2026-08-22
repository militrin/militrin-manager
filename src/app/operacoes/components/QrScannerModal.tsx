"use client";

import { useState } from "react";
import { useQrCameraScanner } from "./useQrCameraScanner";

export function QrScannerModal({
  onClose,
  onRead,
}: {
  onClose: () => void;
  onRead: (value: string) => Promise<void>;
}) {
  const { videoRef, message } = useQrCameraScanner(onRead);
  const [manualValue, setManualValue] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div className="w-full max-w-xl rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">Ler QR Code</h2>
            <p className="text-sm text-slate-400">{message}</p>
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
            onKeyDown={(event) => {
              if (event.key === "Enter" && manualValue.trim()) void onRead(manualValue);
            }}
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
