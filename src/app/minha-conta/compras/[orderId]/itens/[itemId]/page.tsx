import { redirect } from 'next/navigation';

export default async function AccountOrderItemRedirect({ params }: { params: Promise<{ orderId: string; itemId: string }> }) {
  const { orderId, itemId } = await params;
  redirect(`/produto/retirada/checkout/${orderId}/${itemId}`);
}
