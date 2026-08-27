'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEmailProvider } from '@/lib/email/fake-provider';
import { generatePublicPixAction, simulatePublicPaymentAction } from '@/app/inscricao/actions';
import { formatDateBR, toISODateFromBR } from '@/lib/utils/date';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
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
      'id, token, status, issued_at, used_at, owner_user_id, participant_id, event_id, order_id, order_item_id, events(id, name, starts_at, shirt_order_deadline, limit_shirt_selection_to_stock), order_items(id, item_position, status, ownership_status, holder_full_name, shirt_type, shirt_size, ticket_category_id, participant_id, participants(id, full_name, email, shirt_type, shirt_size, ticket_category_id), ticket_categories(name))',
    )
    .eq('id', ticketId)
    .eq('owner_user_id', userId)
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
  const eventId = String(order?.event_id ?? ticket.event_id ?? '');

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, full_name, user_id, event_id')
    .eq('id', participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: 'Titular não encontrado.' };
  if (String(participant.event_id ?? '') !== eventId) {
    return { success: false, message: 'O titular precisa pertencer ao mesmo evento do ingresso.' };
  }
  if (String(participant.user_id ?? '') !== user.id) {
    return { success: false, message: 'Você só pode definir um titular vinculado à sua conta.' };
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

export async function requestTicketItemChangeAction(formData: FormData) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const kitItemId = String(formData.get('kit_item_id') ?? '').trim();
  const requestedVariantId = String(formData.get('requested_variant_id') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  if (!ticketId || !kitItemId || !requestedVariantId) {
    return { success: false, message: 'Selecione um item e uma opção válidos.' };
  }

  const { data: ticket, error } = await loadOwnedTicketContext(supabase, ticketId, user.id);
  if (error) return { success: false, message: error.message };
  if (!ticket) return { success: false, message: 'Ingresso nao encontrado.' };

  const order = getTicketOrder(ticket as Record<string, unknown>);
  const { error: changeError } = await supabase.rpc('request_ticket_item_change', {
    p_ticket_id: ticketId,
    p_kit_item_id: kitItemId,
    p_requested_variant_id: requestedVariantId,
    p_reason: reason || null,
  });
  if (changeError) return { success: false, message: changeError.message };

  revalidatePath('/minha-conta');
  revalidatePath('/minha-conta/ingressos');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);
  revalidatePath(`/minha-conta/compras/${String(order?.id ?? ticket.order_id ?? '')}`);

  return { success: true, message: 'Alteração solicitada · Aguardando confirmação do organizador' };

  /* Legacy direct-stock implementation intentionally disabled. The transaction is
     now owned exclusively by public.change_ticket_shirt(ticket_id, ...).

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
  */
}

export async function findUserByPinAction(ticketId: string, pin: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('find_user_by_public_pin', { p_ticket_id: ticketId, p_pin: pin });
  if (error) return { user: null, message: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { user: null, message: 'Nenhum usuário encontrado para esse PIN.' };
  return { user: { fullName: String(row.full_name) }, message: null };
}

async function changeHolderByPin(functionName: string, ticketId: string, pin: string, extra: Record<string, unknown> = {}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc(functionName, { p_ticket_id: ticketId, p_pin: pin, ...extra });
  if (error) return { success: false, message: error.message.includes('HOLDER_ALREADY_HAS_TICKET_FOR_EVENT') ? 'Esta pessoa ja e titular de outro ingresso neste evento.' : error.message };
  revalidatePath('/minha-conta/ingressos'); revalidatePath(`/minha-conta/ingressos/${ticketId}`); revalidatePath('/operacoes');
  return { success: true, message: 'Titularidade atualizada com sucesso.' };
}

export async function adminChangeTicketShirtAction(ticketId: string, shirtOption: string) {
  await assertPermission('inventory.change_participant_shirt');
  const [shirtType, shirtSize, extra] = shirtOption.split('|');
  if (!ticketId || !shirtType || !shirtSize || extra) return { success: false, message: 'Selecione uma camiseta valida.' };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('admin_change_ticket_shirt', {
    p_ticket_id: ticketId, p_new_shirt_type: shirtType, p_new_shirt_size: shirtSize,
  });
  if (error) {
    if (error.message.includes('SHIRT_OUT_OF_STOCK')) return { success: false, message: 'Esta camiseta nao esta disponivel no estoque.' };
    if (error.message.includes('SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION')) {
      return { success: false, message: 'O tamanho nao pode mais ser alterado porque este ingresso ja teve kit entregue ou check-in realizado.' };
    }
    return { success: false, message: error.message };
  }
  revalidatePath('/operacoes');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);
  return { success: true, message: 'Camiseta atualizada.' };
}
export async function defineTicketHolderByPinAction(ticketId: string, pin: string) { return changeHolderByPin('define_ticket_holder_by_pin', ticketId, pin); }
export async function transferTicketByPinAction(ticketId: string, pin: string) { return changeHolderByPin('transfer_ticket_by_pin', ticketId, pin); }
export async function adminTransferTicketByPinAction(ticketId: string, pin: string, mode: 'define' | 'transfer') {
  await assertPermission('participants.edit_basic');
  return changeHolderByPin('admin_transfer_ticket_by_pin', ticketId, pin, { p_reason: 'Alteração administrativa no detalhe do ingresso', p_operation: mode === 'define' ? 'holder_assigned' : 'ticket_transferred' });
}

export async function reviewTicketItemChangeAction(formData: FormData) {
  await assertPermission('kits.deliver');
  const requestId = String(formData.get('request_id') ?? '').trim();
  const decision = String(formData.get('decision') ?? '').trim();
  const notes = String(formData.get('notes') ?? '').trim();
  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  if (!requestId || !['approved', 'rejected'].includes(decision)) return { success: false, message: 'Solicitação inválida.' };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('review_ticket_item_change_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_notes: notes || null,
  });
  if (error) {
    if (error.message.includes('SHIRT_OUT_OF_STOCK')) {
      return { success: false, message: 'Não há mais estoque disponível para o tamanho solicitado.' };
    }
    if (error.message.includes('SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION')) {
      return { success: false, message: 'Este ingresso já teve kit entregue ou check-in realizado — a aprovação normal está bloqueada. Rejeite esta solicitação e, se necessário, use a correção administrativa na Central de Operações.' };
    }
    // Corrida entre duas aprovações concorrentes pedindo a mesma variante com
    // 1 unidade restante: a checagem de disponibilidade em
    // admin_change_ticket_shirt nao desconta reserved_quantity (so
    // delivered_quantity), entao quem realmente barra a segunda aprovacao e o
    // CHECK (reserved_quantity + delivered_quantity <= total_quantity) da
    // propria tabela de estoque -- nao o erro estruturado SHIRT_OUT_OF_STOCK.
    // Mesma mensagem amigavel pro organizador nos dois casos.
    if (error.message.includes('event_kit_item_variant_inventory_check')) {
      return { success: false, message: 'Não há mais estoque disponível para o tamanho solicitado.' };
    }
    if (error.message.includes('ja revisada')) {
      return { success: false, message: 'Esta solicitação já foi revisada por outra pessoa.' };
    }
    return { success: false, message: error.message };
  }
  revalidatePath('/operacoes');
  revalidatePath('/operacoes/solicitacoes');
  revalidatePath(`/minha-conta/ingressos/${ticketId}`);
  revalidatePath(`/minha-conta/ingressos/${ticketId}/itens`);
  return { success: true, message: decision === 'approved' ? 'Solicitação aprovada.' : 'Solicitação rejeitada.' };
}

export async function updateTicketCategoryAction(formData: FormData) {
  // A permissao e checada AQUI (feedback rapido pro admin) E de novo DENTRO
  // da RPC admin_update_ticket_category (SECURITY DEFINER) -- a segunda
  // checagem e a que realmente conta: nenhuma chamada direta a essa RPC,
  // pulando esta Server Action, escapa da mesma exigencia de permissao.
  // Auditoria encontrou que a escrita anterior (UPDATE direto via client
  // vinculado a sessao) nunca funcionava de verdade -- order_items nao tem
  // nenhuma RLS policy de UPDATE, entao o UPDATE sempre afetava 0 linhas
  // silenciosamente e esta action reportava sucesso sem mudar nada.
  await assertPermission('participants.edit_basic');

  const supabase = await createServerSupabaseClient();
  const ticketId = String(formData.get('ticket_id') ?? '').trim();
  const ticketCategoryId = String(formData.get('ticket_category_id') ?? '').trim();
  const confirmAfterPayment = formData.get('confirm_after_payment') === 'true';
  const overrideReason = String(formData.get('override_reason') ?? '').trim();

  if (!ticketId || !ticketCategoryId) {
    return { success: false, message: 'Selecione uma categoria valida.' };
  }

  const { error } = await supabase.rpc('admin_update_ticket_category', {
    p_ticket_id: ticketId,
    p_ticket_category_id: ticketCategoryId,
    p_confirm_after_payment: confirmAfterPayment,
    p_override_reason: overrideReason || null,
  });

  if (error) return { success: false, message: error.message };

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

  const { error: noteError } = await supabase.rpc('update_participant_event_notes', {
    p_participant_id: participantId, p_notes: notes || null,
  });
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

  const { data: linkedParticipants, error: linkedError } = await supabase
    .from('participants')
    .select('id')
    .eq('user_id', user.id);
  if (linkedError) return { success: false, message: linkedError.message };
  const personalValues = {
    full_name: String(formData.get('full_name') ?? '').trim() || null,
    cpf: profileCpf,
    birth_date: birthDate,
    gender: String(formData.get('gender') ?? '').trim() || null,
    phone: String(formData.get('phone') ?? '').replace(/\D/g, '') || null,
    email: emailValue,
    city: String(formData.get('city') ?? '').trim() || null,
  };
  for (const participant of linkedParticipants ?? []) {
    const { error: contactError } = await supabase.rpc('update_registration_contact_from_participant', {
      p_participant_id: participant.id,
      p_values: personalValues,
    });
    if (contactError) return { success: false, message: contactError.message };
  }

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
    .select('id, token')
    .eq('order_id', order.id)
    .maybeSingle();

  if (ticketError) return { success: false, message: ticketError.message };
  if (!ticket?.token) return { success: false, message: 'Ingresso ainda nao emitido.' };

  const { data: kitItems, error: kitError } = await supabase.rpc('get_ticket_kit_items', {
    p_ticket_id: ticket.id,
  });
  if (kitError) return { success: false, message: kitError.message };

  const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
  const eventData = Array.isArray(order.events) ? order.events[0] : order.events;
  const participantEmail = String(participant?.email ?? '').trim().toLowerCase();

  if (!participantEmail) {
    return { success: false, message: 'Não foi possível identificar o e-mail do titular.' };
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
