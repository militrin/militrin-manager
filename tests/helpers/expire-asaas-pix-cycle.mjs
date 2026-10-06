export async function backdateShortCheckoutHold(service, orderId) {
  const createdAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() - 30 * 1000).toISOString();
  const payUp = await service.from('payments').update({
    created_at: createdAt,
    expires_at: expiresAt,
  }).eq('order_id', orderId);
  if (payUp.error) throw new Error(`backdate payment: ${JSON.stringify(payUp.error)}`);
  const itemUp = await service.from('order_items').update({
    reservation_expires_at: expiresAt,
  }).eq('order_id', orderId);
  if (itemUp.error) throw new Error(`backdate items: ${JSON.stringify(itemUp.error)}`);
}

export async function simulateConfirmedAsaasPixDelete(service, orderId) {
  const { data: pay, error } = await service
    .from('payments')
    .select('id, payment_status, pending_cancel_provider_payment_id')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw new Error(`load payment: ${JSON.stringify(error)}`);
  if (!pay || pay.payment_status !== 'pending' || !pay.pending_cancel_provider_payment_id) {
    return pay?.payment_status ?? null;
  }
  const done = await service.rpc('complete_expired_pix_cancellation', { p_payment_id: pay.id });
  if (done.error) throw new Error(`complete expired: ${JSON.stringify(done.error)}`);
  return done.data;
}

/** Carimba expiracao, confirma DELETE e so entao terminaliza (estoque libera). */
export async function expireStaleAsaasPixAndConfirmDelete(service, { organizationId, orderId, orderIds }) {
  const ids = orderIds ?? (orderId ? [orderId] : []);
  for (const id of ids) {
    await backdateShortCheckoutHold(service, id);
  }
  const stamped = await service.rpc('expire_stale_order_payments', { p_organization_id: organizationId });
  if (stamped.error) throw new Error(`expire_stale: ${JSON.stringify(stamped.error)}`);
  for (const id of ids) {
    await simulateConfirmedAsaasPixDelete(service, id);
  }
  return stamped.data;
}
