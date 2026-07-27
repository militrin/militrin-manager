"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Copy } from "lucide-react";

type PaymentPanelProps = {
  payment: {
    payment_status: string;
    payment_method: string | null;
    pix_code: string | null;
    pix_qrcode: string | null;
    expires_at: string | null;
    paid_at: string | null;
    final_amount: number;
  } | null;
};

function formatCountdown(expiresAt: string, nowMs: number) {
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function PaymentPanel({ payment }: PaymentPanelProps) {
  const [ticker, setTicker] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!payment?.expires_at || payment.payment_status !== "pending") return;
    const first = window.setTimeout(() => setNowMs(Date.now()), 0);
    const timer = window.setInterval(() => {
      setTicker((value) => value + 1);
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [payment?.expires_at, payment?.payment_status]);

  const remaining = useMemo(() => {
    if (!payment?.expires_at || payment.payment_status !== "pending") return null;
    if (nowMs <= 0) return null;
    void ticker;
    return formatCountdown(payment.expires_at, nowMs);
  }, [payment?.expires_at, payment?.payment_status, ticker, nowMs]);

  if (!payment) {
    return (
      <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
        Nenhum pagamento encontrado para este participante.
      </div>
    );
  }

  const copyCode = async () => {
    if (!payment.pix_code) return;
    try {
      await navigator.clipboard.writeText(payment.pix_code);
      setMessage("Código PIX copiado.");
    } catch {
      setMessage("Não foi possível copiar o código PIX.");
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-sm font-semibold text-slate-100">Pagamento</p>
      <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
        <p>Status: {payment.payment_status}</p>
        <p>Forma: {payment.payment_method ?? "não definida"}</p>
        <p>Valor final: R$ {Number(payment.final_amount ?? 0).toFixed(2)}</p>
        <p>Tempo restante: {remaining ?? "--"}</p>
      </div>

      {payment.pix_qrcode ? (
        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
          <p className="mb-2 text-xs text-slate-300">QR Code PIX</p>
          <Image
            src={payment.pix_qrcode}
            alt="QR Code PIX"
            width={160}
            height={160}
            unoptimized
            className="h-40 w-40 rounded-md border border-slate-700"
          />
          <p className="mt-2 break-all text-xs text-slate-400">{payment.pix_code}</p>
          <button
            type="button"
            onClick={copyCode}
            className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200"
          >
            <Copy size={12} /> Copiar código
          </button>
        </div>
      ) : null}

      {message ? <p className="mt-3 text-xs text-emerald-300">{message}</p> : null}
    </div>
  );
}
