import { redirect } from 'next/navigation';

export default async function AccountStoreItemRedirect({ params }: { params: Promise<{ storeOrderId: string; itemId: string }> }) {
  const { storeOrderId, itemId } = await params;
  redirect(`/produto/retirada/loja/${storeOrderId}/${itemId}`);
}
