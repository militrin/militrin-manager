'use client';

import { useEffect, useRef, useState } from 'react';

export function QrScanner({ title, onRead, onCancel, compact = false }: { title: string; onRead: (value: string) => Promise<void>; onCancel?: () => void; compact?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastReadRef = useRef<string>('');
  const [manual, setManual] = useState('');
  const [message, setMessage] = useState('Aponte a câmera para o QR Code.');

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) return stream.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const Detector = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector;
        if (!Detector) return setMessage('Leitura automática não disponível. Use um leitor USB ou cole o código abaixo.');
        const detector = new Detector({ formats: ['qr_code'] });
        const scan = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue?.trim();
            if (value && value !== lastReadRef.current) {
              lastReadRef.current = value;
              setMessage('QR Code localizado.');
              await onRead(value);
              window.setTimeout(() => { lastReadRef.current = ''; }, 1200);
            }
          } catch { /* continua */ }
          timer = window.setTimeout(scan, 250);
        };
        timer = window.setTimeout(scan, 400);
      } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível abrir a câmera.'); }
    }
    void start();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); streamRef.current?.getTracks().forEach((track) => track.stop()); };
  }, [onRead]);

  return <div className={compact ? 'space-y-3' : 'rounded-3xl border border-slate-700 bg-slate-900 p-5'}>
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-bold">{title}</h2><p className="text-sm text-slate-400">{message}</p></div>{onCancel ? <button type="button" onClick={onCancel} className="rounded-xl border border-slate-700 px-3 py-2 text-sm">Cancelar</button> : null}</div>
    <video ref={videoRef} playsInline muted className="mt-3 aspect-video w-full rounded-2xl bg-black object-cover" />
    <div className="flex gap-2"><input value={manual} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && manual.trim()) void onRead(manual); }} placeholder="Leitor USB ou código manual" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" /><button type="button" onClick={() => void onRead(manual)} disabled={!manual.trim()} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-50">Ler</button></div>
  </div>;
}
