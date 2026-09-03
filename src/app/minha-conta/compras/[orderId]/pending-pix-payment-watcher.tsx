'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getPublicOrderPaymentStatusAction } from '@/app/inscricao/actions';

/**
 * Polling controlado enquanto o PIX do comprador ainda esta pending.
 * Para em paid/expired/cancelled/error. Nao busca PIX, CPF nem IDs de gateway.
 */
export function PendingPixPaymentWatcher({
  orderId,
  paymentStatus,
}: {
  orderId: string;
  paymentStatus: string;
}) {
  const router = useRouter();
  const status = String(paymentStatus ?? '').trim().toLowerCase();
  const shouldPoll = status === 'pending' || status === 'processing';
  const inFlight = useRef(false);

  useEffect(() => {
    if (!shouldPoll || !orderId) return;

    let cancelled = false;

    async function refresh() {
      if (inFlight.current || cancelled) return;
      inFlight.current = true;
      try {
        const result = await getPublicOrderPaymentStatusAction(orderId);
        if (cancelled || !result.success) return;
        if (result.payment_status !== 'pending' && result.payment_status !== 'processing') {
          router.refresh();
        }
      } finally {
        inFlight.current = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orderId, router, shouldPoll]);

  return null;
}
