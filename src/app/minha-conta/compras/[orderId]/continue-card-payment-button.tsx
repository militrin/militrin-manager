'use client';

import { useState, useTransition } from 'react';
import { generatePublicOrderCardAction } from '@/app/inscricao/actions';
import { beginCardCheckoutRedirect, endCardCheckoutRedirect, markCardCheckoutAttempted } from '@/lib/checkout/card-checkout-redirect';
import { MilitrinButton } from '@/components/militrin';

export function ContinueCardPaymentButton({ orderId }: { orderId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleContinue() {
    if (!orderId || isPending) return;
    setError(null);
    if (!beginCardCheckoutRedirect(orderId)) return;

    startTransition(async () => {
      let redirected = false;
      try {
        const result = await generatePublicOrderCardAction(orderId);
        if (!result.success) {
          setError(result.message || 'Nao foi possivel continuar o pagamento com cartao.');
          return;
        }
        if (String(result.payment?.payment_status ?? '').trim().toLowerCase() === 'paid') {
          redirected = true;
          window.location.assign(`/minha-conta/compras/${orderId}`);
          return;
        }
        const checkoutUrl = String(result.payment?.checkout_url ?? '').trim();
        if (!checkoutUrl) {
          setError('Nao foi possivel abrir o pagamento com cartao. Tente novamente em instantes.');
          return;
        }
        markCardCheckoutAttempted(orderId);
        redirected = true;
        window.location.assign(checkoutUrl);
      } catch {
        setError('Nao foi possivel continuar o pagamento com cartao. Tente novamente em instantes.');
      } finally {
        if (!redirected) endCardCheckoutRedirect(orderId);
      }
    });
  }

  return (
    <div className="space-y-2">
      <MilitrinButton type="button" onClick={handleContinue} loading={isPending} disabled={isPending}>
        {isPending ? 'Preparando pagamento...' : 'Continuar pagamento'}
      </MilitrinButton>
      {error ? <p className="max-w-sm text-sm text-red-200">{error}</p> : null}
    </div>
  );
}
