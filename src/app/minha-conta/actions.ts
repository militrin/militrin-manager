'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEmailProvider } from '@/lib/email/fake-provider';
import { generatePublicPixAction, simulatePublicPaymentAction } from '@/app/inscricao/actions';
import { formatDateBR, toISODateFromBR } from '@/lib/utils/date';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
import { normalizeShirtSize as normalizeShirtSizeBase, normalizeShirtType } from '@/lib/constants/shirts';
import { assertPermission } from '@/lib/admin/permissions';

const emailProvider = getEmailProvider();

function appBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

async function loadOwnedTicketContext(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>, ticketId: string, userId: string) {
  return supabase
    .from('tickets')
    .select(
      'id, token, status, issued_at, used_at, ownership_status, participant_id, order_id, order_item_id, orders!inner(id, order_number, status, user_id, event_id, events(id, name, starts_at, shirt_order_deadline, limit_shirt_selection_to_stock)), order_items(id, item_position, status, ownership_status, holder_full_name, shirt_type, shirt_size, ticket_category_id, participant_id, notes, participants(id, full_name, email, shirt_type, shirt_size, ticket_category_id), ticket_categories(name))',
    )
    .eq('id', ticketId)
    .eq('orders.user_id', userId)
    .maybeSingle();
}

function getTicketOrder(ticket: Record<string, unknown> | null | undefined) {
  const order = Array.isArray(ticket?.orders) ? ticket?.orders[0] : ticket?.orders;
  return (order as Record<string, unknown> | null | undefined) ?? null;
}

function getTicketOrderItem(ticket: Record<string, unknown> | null | undefined) {
  const orderItem = Array.isArray(ticket?.order_items) ? ticket?.order_items[0] : ticket?.order_items;
  return (orderItem as Record<string, unknown> | null | undefined) ?? null;
}

export async function defineTicketHolderAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const participantId = String(formData.get('participant_id') ?? '').trim();

  if (!ticketId || !participantId) {
    return { success: false, message: 'Selecione um titular valido.' };
  }

  const { data: ticket, error } = await loadOwnedTicketContext(supabase, ticketId, user.id);
  if (error) return { success: false, message: error.message };
  if (!ticket) return { success: false, message: 'Ingresso nao encontrado.' };

  const orderItem = getTicketOrderItem(ticket as Record<string, unknown>);
  const order = getTicketOrder(ticket as Record<string, unknown>);
  const eventId = String(order?.event_id ?? '');

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, full_name, user_id, event_id')
    .eq('id', participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: 'Participante nao encontrado.' };
  if (String(participant.event_id ?? '') !== eventId) {
    return { success: false, message: 'O titular precisa pertencer ao mesmo evento do ingresso.' };
  }
  if (String(participant.user_id ?? '') !== user.id) {
    return { success: false, message: 'Voce so pode definir titular com um participante vinculado a sua conta.' };
  }

  const { error: assignError } = await supabase.rpc('assign_order_item_participant', {
    p_order_item_id: String(orderItem?.id ?? ticket.order_item_id ?? ticket.id),
    p_participant_id: participantId,
  });

  if (assignError) return { success: false, message: assignError.message };

  await supabase
    .from('order_items')
    .update({ holder_full_name: String(participant.full_name ?? ''), updated_at: new Date().toISOString() })
    .eq('id', String(orderItem?.id ?? ticket.order_item_id ?? ''));

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/ingressos');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);
  revalidatePath(`/minha-conta/compras/${String(order?.id ?? ticket.order_id ?? '')}`);

  return { success: true, message: 'Titular definido com sucesso.' };
}

export async function transferTicketAction(formData: FormData) {
  const result = await defineTicketHolderAction(formData);
  if (!result.success) return result;
  return { ...result, message: 'Ingresso transferido com sucesso.' };
}

export async function changeTicketShirtAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const shirtType = normalizeShirtType(String(formData.get('shirt_type') ?? ''));
  const shirtSize = shirtType ? normalizeShirtSizeBase(String(formData.get('shirt_size') ?? '')) : '';

  if (!ticketId || !shirtType || !shirtSize) {
    return { success: false, message: 'Selecione modelo e tamanho validos.' };
  }

  const { data: ticket, error } = await loadOwnedTicketContext(supabase, ticketId, user.id);
  if (error) return { success: false, message: error.message };
  if (!ticket) return { success: false, message: 'Ingresso nao encontrado.' };

  const orderItem = getTicketOrderItem(ticket as Record<string, unknown>);
  const order = getTicketOrder(ticket as Record<string, unknown>);
  const participant = Array.isArray(orderItem?.participants) ? orderItem.participants[0] : orderItem?.participants;
  const event = Array.isArray(order?.events) ? order.events[0] : order?.events;
  const eventId = String(order?.event_id ?? '');
  const enforcePhysicalStock = Boolean(event?.limit_shirt_selection_to_stock);
  const currentType = normalizeShirtType(String(orderItem?.shirt_type ?? participant?.shirt_type ?? ''));
  const currentSize = normalizeShirtSizeBase(String(orderItem?.shirt_size ?? participant?.shirt_size ?? ''));

  const { data: currentStock, error: currentStockError } = await supabase
    .from('shirt_inventory')
    .select('id, total_quantity, reserved_quantity, delivered_quantity')
    .eq('event_id', eventId)
    .eq('shirt_type', currentType)
    .eq('shirt_size', currentSize)
    .maybeSingle();
  if (currentStockError) return { success: false, message: currentStockError.message };

  const { data: nextStock, error: nextStockError } = await supabase
    .from('shirt_inventory')
    .select('id, total_quantity, reserved_quantity, delivered_quantity')
    .eq('event_id', eventId)
    .eq('shirt_type', shirtType)
    .eq('shirt_size', shirtSize)
    .maybeSingle();
  if (nextStockError) return { success: false, message: nextStockError.message };
  if (!nextStock?.id) return { success: false, message: 'Estoque nao configurado para o novo modelo/tamanho.' };

  if (currentType === shirtType && currentSize === shirtSize) {
    return { success: true, message: 'Camiseta ja esta neste modelo e tamanho.' };
  }

  const available = Number(nextStock.total_quantity ?? 0) - Number(nextStock.reserved_quantity ?? 0) - Number(nextStock.delivered_quantity ?? 0);
  if (enforcePhysicalStock && available <= 0) {
    return { success: false, message: 'Nao ha estoque disponivel para alterar a camiseta com a limitação ativa.' };
  }

  if (currentStock?.id && currentStock.id !== nextStock.id) {
    await supabase
      .from('shirt_inventory')
      .update({ reserved_quantity: Math.max(0, Number(currentStock.reserved_quantity ?? 0) - 1), updated_at: new Date().toISOString() })
      .eq('id', currentStock.id);
  }

  await supabase
    .from('shirt_inventory')
    .update({ reserved_quantity: Number(nextStock.reserved_quantity ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq('id', nextStock.id);

  if (participant?.id) {
    await supabase
      .from('participants')
      .update({ shirt_type: shirtType, shirt_size: shirtSize, updated_at: new Date().toISOString() })
      .eq('id', String(participant.id));
  }

  if (orderItem?.id) {
    await supabase
      .from('order_items')
      .update({ shirt_type: shirtType, shirt_size: shirtSize, updated_at: new Date().toISOString() })
      .eq('id', String(orderItem.id));
  }

await supabase.from('audit_logs').insert({
  action: 'ticket_shirt_changed',
  entity_type: 'tickets',
  entity_id: String(ticket.id),
  event_id: eventId,
  details: {
    actor: user.id,
    previous_type: currentType,
    previous_size: currentSize,
    next_type: shirtType,
    next_size: shirtSize,
    limit_shirt_selection_to_stock: enforcePhysicalStock,
  },
});

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/ingressos');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);
  revalidatePath(`/minha-conta/compras/${String(order?.id ?? ticket.order_id ?? '')}`);

  return {
    success: true,
    message: enforcePhysicalStock ? 'Camiseta alterada com estoque validado.' : 'Camiseta alterada com sucesso.',
  };
}

export async function updateTicketCategoryAction(formData: FormData) {
  await assertPermission('participants.edit_basic');

  const supabase = await createServerSupabaseClient();
  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const ticketCategoryId = String(formData.get('ticket_category_id') ?? '').trim();

  if (!ticketId || !ticketCategoryId) {
    return { success: false, message: 'Selecione uma categoria valida.' };
  }

  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('id, order_id, order_item_id, orders!inner(id, event_id), order_items(id, participant_id, ticket_category_id)')
    .eq('id', ticketId)
    .maybeSingle();

  if (error) return { success: false, message: error.message };
  if (!ticket) return { success: false, message: 'Ingresso nao encontrado.' };

  const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
  const orderItem = Array.isArray(ticket.order_items) ? ticket.order_items[0] : ticket.order_items;
  const eventId = String(order?.event_id ?? '');

  const { data: allowedCategory } = await supabase
    .from('ticket_categories')
    .select('id')
    .eq('id', ticketCategoryId)
    .eq('event_id', eventId)
    .maybeSingle();

  if (!allowedCategory?.id) {
    return { success: false, message: 'Categoria nao pertence ao evento do ingresso.' };
  }

  if (orderItem?.id) {
    await supabase.from('order_items').update({ ticket_category_id: ticketCategoryId, updated_at: new Date().toISOString() }).eq('id', String(orderItem.id));
  }

  if (orderItem?.participant_id) {
    await supabase.from('participants').update({ ticket_category_id: ticketCategoryId, updated_at: new Date().toISOString() }).eq('id', String(orderItem.participant_id));
  }

await supabase.from('audit_logs').insert({
  action: 'ticket_category_changed',
  entity_type: 'tickets',
  entity_id: ticketId,
  event_id: eventId,
  details: {
    actor: 'admin',
    ticket_category_id: ticketCategoryId,
  },
});

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/ingressos');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);

  return { success: true, message: 'Categoria atualizada com sucesso.' };
}

export async function updateTicketNotesAction(formData: FormData) {
  await assertPermission('participants.edit_basic');

  const supabase = await createServerSupabaseClient();
  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();

  if (!ticketId) {
    return { success: false, message: 'Ingresso nao encontrado.' };
  }

  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('id, order_id, orders!inner(id, event_id), order_items(id, participant_id)')
    .eq('id', ticketId)
    .maybeSingle();

  if (error) return { success: false, message: error.message };
  if (!ticket) return { success: false, message: 'Ingresso nao encontrado.' };

  const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
  const orderItem = Array.isArray(ticket.order_items) ? ticket.order_items[0] : ticket.order_items;
  const participantId = String(orderItem?.participant_id ?? '');

  if (!participantId) {
    return { success: false, message: 'Titular ainda nao definido. Defina o titular antes de registrar observacoes.' };
  }

  const { error: noteError } = await supabase.from('participants').update({ notes: notes || null, updated_at: new Date().toISOString() }).eq('id', participantId);
  if (noteError) return { success: false, message: noteError.message };

  await supabase.from('audit_logs').insert({
  action: 'ticket_notes_updated',
  entity_type: 'participants',
  entity_id: participantId,
  event_id: String(order?.event_id ?? ''),
  details: {
    actor: 'admin',
    notes: notes || null,
  },
});

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/ingressos');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);

  return { success: true, message: 'Observacoes atualizadas com sucesso.' };
}

export async function signOutAccountAction() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect('/');
}

export async function updateMyProfileAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: profileData } = await supabase.rpc('get_customer_profile', { p_user_id: user.id });
  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const birthDateValue = String(formData.get('birth_date') ?? '').trim();
  const birthDate = birthDateValue ? toISODateFromBR(birthDateValue) : String(profile?.birth_date ?? null) || null;
  const emailValue = String(user.email ?? profile?.email ?? '').trim() || null;
  const profileCpf = String(profile?.cpf ?? '').replace(/\D/g, '') || null;
  const photoUrl = String(formData.get('photo_url') ?? '').trim() || null;

  const { error } = await upsertCustomerProfileCompat(supabase, {
    userId: user.id,
    fullName: String(formData.get('full_name') ?? '').trim() || null,
    cpf: profileCpf,
    birthDate,
    gender: String(formData.get('gender') ?? '').trim() || null,
    phone: String(formData.get('phone') ?? '').replace(/\D/g, '') || null,
    email: emailValue,
    city: String(formData.get('city') ?? '').trim() || null,
    loyaltyTierId: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
    loyaltyOverride: Boolean(profile?.loyalty_override),
    loyaltyOverrideReason: profile?.loyalty_override_reason ? String(profile.loyalty_override_reason) : null,
    showInParticipantList: formData.get('show_in_participant_list') === 'on',
    allowFriendRequests: formData.get('allow_friend_requests') === 'on',
    profileVisibility: String(formData.get('profile_visibility') ?? profile?.profile_visibility ?? 'participants'),
  });

  if (error) return { success: false, message: error.message };

  const currentMetadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const metadataUpdate = {
    ...currentMetadata,
    avatar_url: photoUrl,
  };

  const { error: metadataError } = await supabase.auth.updateUser({
    data: metadataUpdate,
  });

  if (metadataError) {
    return { success: false, message: metadataError.message };
  }

  return { success: true };
}

export async function updatePasswordAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const password = String(formData.get('new_password') ?? '');
  const confirmPassword = String(formData.get('confirm_password') ?? '');

  if (password.length < 8) {
    return { success: false, message: 'A senha deve ter pelo menos 8 caracteres.' };
  }

  if (password !== confirmPassword) {
    return { success: false, message: 'A confirmacao de senha nao confere.' };
  }

  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: 'Senha atualizada com sucesso.' };
}

export async function requestEmailChangeAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const newEmail = normalizeEmail(String(formData.get('email') ?? ''));
  if (!newEmail) {
    return { success: false, message: 'Informe um novo e-mail.' };
  }

  const { error } = await supabase.auth.updateUser({
    email: newEmail,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: 'Verifique seu e-mail para confirmar a alteração.' };
}

export async function resendTicketEmailAction(orderId: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, order_number, status, participant_id, events(name, starts_at, location), participants(full_name, email, ticket_categories(name))')
    .eq('id', orderId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (orderError) return { success: false, message: orderError.message };
  if (!order) return { success: false, message: 'Pedido nao encontrado.' };
  if (order.status !== 'confirmed') {
    return { success: false, message: 'Ingresso disponivel apenas para pedido confirmado.' };
  }

  const { data: ticket, error: ticketError } = await supabase
    .from('tickets')
    .select('token')
    .eq('order_id', order.id)
    .maybeSingle();

  if (ticketError) return { success: false, message: ticketError.message };
  if (!ticket?.token) return { success: false, message: 'Ingresso ainda nao emitido.' };

  const { data: kitItems, error: kitError } = await supabase.rpc('get_participant_kit_items', {
    p_participant_id: order.participant_id,
  });
  if (kitError) return { success: false, message: kitError.message };

  const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
  const eventData = Array.isArray(order.events) ? order.events[0] : order.events;
  const participantEmail = String(participant?.email ?? '').trim().toLowerCase();

  if (!participantEmail) {
    return { success: false, message: 'Nao foi possivel identificar o e-mail do participante.' };
  }

  await emailProvider.sendTicketConfirmation({
    to: participantEmail,
    participantName: String(participant?.full_name ?? ''),
    eventName: String(eventData?.name ?? 'Evento'),
    eventDate: eventData?.starts_at ? formatDateBR(String(eventData.starts_at)) : null,
    eventLocation: eventData?.location ? String(eventData.location) : null,
    categoryName: (() => {
      const category = participant?.ticket_categories;
      const categoryObj = Array.isArray(category) ? category[0] : category;
      return categoryObj?.name ? String(categoryObj.name) : null;
    })(),
    kitItems: (kitItems ?? []).map((item: Record<string, unknown>) => ({
      name: String(item.item_name ?? ''),
      quantity: Number(item.quantity ?? 1),
    })),
    orderNumber: String(order.order_number),
    ticketToken: String(ticket.token),
    accountUrl: `${appBaseUrl()}/minha-conta/compras/${order.id}`,
  });

  return { success: true, message: 'Ingresso reenviado por e-mail.' };
}

export async function payOrderNowAction(orderId: string) {
  if (process.env.NODE_ENV !== 'development') {
    return { success: false, message: 'Pagamento simulado disponivel apenas em desenvolvimento.' };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, participant_id, status, payments(payment_method, payment_status, pix_code)')
    .eq('id', orderId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return { success: false, message: error.message };
  if (!order?.participant_id) return { success: false, message: 'Pedido nao encontrado.' };

  const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
  const paymentStatus = String(payment?.payment_status ?? 'pending');
  const paymentMethod = String(payment?.payment_method ?? 'pix') as 'pix' | 'credit_card';

  if (paymentStatus === 'paid' || String(order.status) === 'confirmed') {
    return { success: true, message: 'Pagamento ja confirmado.' };
  }

  if (paymentMethod === 'pix' && !String(payment?.pix_code ?? '').trim()) {
    const pix = await generatePublicPixAction(String(order.participant_id));
    if (!pix.success) {
      return { success: false, message: pix.message || 'Falha ao gerar PIX.' };
    }
  }

  const paid = await simulatePublicPaymentAction(String(order.participant_id), paymentMethod);
  if (!paid.success) {
    return { success: false, message: paid.message || 'Falha ao processar pagamento.' };
  }

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/compras');
  revalidatePath(`/minha-conta/compras/${orderId}`);
  revalidatePath('/minha-conta/ingressos');

  return { success: true, message: 'Pagamento confirmado.' };
}
