"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminStatusBadge, SlideOverPanel } from "@/components/admin";
import { formatDateTimeBR, formatEventDateTimeWithSeconds } from "@/lib/utils/date";
import {
  couponHasRecordedUses,
  presentCouponUsage,
  remainingCouponUses,
  type CouponUsagePresentation,
  type CouponUsageRow,
} from "@/lib/coupons/usage";
import { getCouponUsagesAction } from "./actions";

function money(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-0.5 text-sm text-slate-100">{children}</div>
    </div>
  );
}

export function CouponUsagesPanel({
  coupon,
  canOpenRelatedRecords,
  onClose,
}: {
  coupon: { id: string; code: string; max_uses: number | null; used_count: number };
  canOpenRelatedRecords: boolean;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usages, setUsages] = useState<CouponUsagePresentation[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getCouponUsagesAction(coupon.id).then((result) => {
      if (!active) return;
      if (!result.success) {
        setError(result.message);
        setUsages([]);
        setLoading(false);
        return;
      }
      setUsages((result.rows as CouponUsageRow[]).map(presentCouponUsage));
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [coupon.id]);

  const remaining = remainingCouponUses(coupon.used_count, coupon.max_uses);

  return (
    <SlideOverPanel open onClose={onClose} title="Utilizações do cupom" mobileSheet>
      <p className="font-mono text-lg font-semibold tracking-wide text-emerald-200">{coupon.code}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-center text-sm">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Limite</p>
          <p className="mt-1 font-semibold">{coupon.max_uses == null ? "Ilimitado" : coupon.max_uses}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Utilizados</p>
          <p className="mt-1 font-semibold">{coupon.used_count}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Restantes</p>
          <p className="mt-1 font-semibold">{remaining == null ? "Ilimitado" : remaining}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Utilizou o cupom ≠ pagou o pedido. O uso consome o limite ao aplicar o cupom no carrinho, mesmo se o PIX expirar.
      </p>

      {loading ? <p className="mt-4 text-sm text-slate-400">Carregando utilizações...</p> : null}
      {error ? <p className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      {!loading && !error && usages.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">
          {couponHasRecordedUses(coupon.used_count)
            ? "O contador registra utilização, mas nenhum pedido está com este cupom aplicado neste momento."
            : "Nenhuma utilização."}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {usages.map((usage) => (
          <CouponUsageCard key={usage.orderId} usage={usage} canOpenRelatedRecords={canOpenRelatedRecords} />
        ))}
      </div>
    </SlideOverPanel>
  );
}

function CouponUsageCard({
  usage,
  canOpenRelatedRecords,
}: {
  usage: CouponUsagePresentation;
  canOpenRelatedRecords: boolean;
}) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cadastro</p>
          <p className="text-sm font-semibold text-slate-100">{usage.cadastroName}</p>
          {usage.buyerFallbackName ? <p className="text-xs text-slate-300">Comprador: {usage.buyerFallbackName}</p> : null}
          {usage.cadastroEmail ? <p className="text-xs text-slate-400">{usage.cadastroEmail}</p> : null}
        </div>
        <AdminStatusBadge status={usage.payment.badge} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Pedido">{usage.orderNumber}</Field>
        <Field label="Cupom aplicado">
          {usage.appliedAt ? formatEventDateTimeWithSeconds(usage.appliedAt) ?? formatDateTimeBR(usage.appliedAt) : "—"}
        </Field>
        <Field label="Valor original">{money(usage.originalAmount)}</Field>
        <Field label="Desconto concedido">{money(usage.discountAmount)}</Field>
        <Field label="Valor após desconto">{money(usage.afterDiscountAmount)}</Field>
        <Field label="Forma de pagamento">{usage.payment.methodLabel}</Field>
        <Field label="Pago em">{usage.payment.isPaid && usage.payment.paidAt ? formatDateTimeBR(usage.payment.paidAt) : "—"}</Field>
        <Field label="Valor pago">{usage.payment.isPaid ? money(usage.payment.paidAmount) : "—"}</Field>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        {usage.payment.isPaid ? "Pagamento: pago." : "Pagamento: não pago."} Este pedido continua consumindo o limite do cupom.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {usage.cadastroIdentified && canOpenRelatedRecords ? (
          <Link href={`/cadastros/${usage.cadastroId}`} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-200">
            Ver cadastro
          </Link>
        ) : null}
        {canOpenRelatedRecords ? (
          <Link href={`/inscricoes/pedido/${usage.orderId}`} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200">
            Ver pedido
          </Link>
        ) : null}
      </div>
    </article>
  );
}
