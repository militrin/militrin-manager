import { appBaseUrl } from "@/lib/urls/app-base-url";

export function cardPaymentReturnPath(orderId: string): string {
  return `/pagamento/retorno?pedido=${encodeURIComponent(orderId)}`;
}

export function cardPaymentReturnUrl(orderId: string): string {
  return `${appBaseUrl()}${cardPaymentReturnPath(orderId)}`;
}
