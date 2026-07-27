'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEmailProvider } from '@/lib/email/fake-provider';
import { generatePublicPixAction, simulatePublicPaymentAction } from '@/app/inscricao/actions';
import { formatDateBR, toISODateFromBR } from '@/lib/utils/date';

const emailProvider = getEmailProvider();

function appBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
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

  const { error } = await supabase.rpc('upsert_customer_profile', {
    p_user_id: user.id,
    p_full_name: String(formData.get('full_name') ?? '').trim() || null,
    p_cpf: profileCpf,
    p_birth_date: birthDate,
    p_gender: String(formData.get('gender') ?? '').trim() || null,
    p_phone: String(formData.get('phone') ?? '').replace(/\D/g, '') || null,
    p_email: emailValue,
    p_city: String(formData.get('city') ?? '').trim() || null,
    p_loyalty_tier_id: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
    p_loyalty_override: Boolean(profile?.loyalty_override),
    p_loyalty_override_reason: profile?.loyalty_override_reason ? String(profile.loyalty_override_reason) : null,
    p_show_in_participant_list: formData.get('show_in_participant_list') === 'on',
    p_allow_friend_requests: formData.get('allow_friend_requests') === 'on',
    p_profile_visibility: String(formData.get('profile_visibility') ?? profile?.profile_visibility ?? 'participants'),
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
