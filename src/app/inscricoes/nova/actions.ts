'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments/get-provider';
import type { RegistrationFormValues } from '@/lib/validation/registration';
import { removeCpfMask } from '@/lib/validation/registration';
import { toISODateFromBR } from '@/lib/utils/date';
import { registrationContactHasActiveTicket } from '@/lib/registrations/active-ticket-holder';

type PricingPreview = {
  batch_id: string;
  batch_name: string;
  sequence_number: number;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  remaining_slots: number;
  coupon_message: string | null;
  coupon_type: string | null;
  discount_percent: number;
};

type FormContext = {
  active_event_id: string;
  active_event_name: string;
  kit_enabled: boolean;
  registration_enabled: boolean;
  has_shirt_item: boolean;
  batch_name: string;
  male_price: number;
  female_price: number;
  remaining_slots: number;
  inventory: Array<{
    shirt_type: string;
    shirt_size: string;
    available_quantity: number;
  }>;
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    capacity: number | null;
    available_slots: number | null;
    is_active: boolean;
  }>;
  kit_items: Array<{
    id: string;
    name: string;
    slug: string;
    item_type: string;
    quantity_per_participant: number;
    requires_variant: boolean;
    is_required: boolean;
    is_active: boolean;
  }>;
};

type RegistrationCreated = {
  participant_id: string;
  order_id: string;
  order_item_id: string;
  payment_id: string;
  ticket_id: string | null;
  full_name: string;
  batch_name: string;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  payment_status: string;
  reservation_expires_at: string | null;
  shirt_type: string;
  shirt_size: string;
};

type ParticipantPaymentDetails = {
  payment_id: string;
  participant_id: string;
  event_id: string;
  event_name: string | null;
  amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method: string | null;
  payment_status: string;
  pix_code: string | null;
  pix_qrcode: string | null;
  gateway_payment_id: string | null;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

const paymentProvider = getPaymentProvider();

export async function getRegistrationFormContextAction(eventId: string) {
  const supabase = await createServerSupabaseClient();

  if (!eventId) return { success: false, message: 'Selecione explicitamente um evento.', unavailable: true };

  const { data: activeEvent, error: activeEventError } = await supabase
    .from('events')
    .select('id, name, kit_enabled, registration_enabled')
    .eq('id', eventId)
    .is('archived_at', null)
    .maybeSingle();

  if (activeEventError || !activeEvent?.id) {
    return {
      success: false,
      message: activeEventError?.message ?? 'Nenhum evento ativo encontrado.',
      unavailable: true,
    };
  }

  if (!Boolean(activeEvent.registration_enabled)) {
    return {
      success: false,
      message: 'Inscrições fechadas para o evento ativo.',
      unavailable: true,
    };
  }

  const [{ data: batchData, error: batchError }, { data: inventoryData, error: inventoryError }, { data: categoriesData, error: categoriesError }, { data: kitItemsData, error: kitItemsError }] = await Promise.all([
    supabase.rpc('get_active_registration_batch'),
    supabase
      .from('shirt_inventory')
      .select('shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity')
      .eq('event_id', activeEvent.id),
    supabase.rpc('get_event_ticket_categories', {
      p_event_id: activeEvent.id,
    }),
    supabase.rpc('get_event_kit_items', {
      p_event_id: activeEvent.id,
    }),
  ]);

  if (batchError) {
    const unavailable = /lote ativo|inscricoes indisponiveis|esgotados/i.test(batchError.message ?? '');
    return {
      success: false,
      message: unavailable ? 'Inscrições indisponíveis no momento' : batchError.message,
      unavailable,
    };
  }

  if (inventoryError) {
    return {
      success: false,
      message: inventoryError.message,
      unavailable: false,
    };
  }

  if (categoriesError) {
    return {
      success: false,
      message: categoriesError.message,
      unavailable: false,
    };
  }

  if (kitItemsError) {
    return {
      success: false,
      message: kitItemsError.message,
      unavailable: false,
    };
  }

  const batch = (Array.isArray(batchData) ? batchData[0] : batchData) as {
    batch_name: string;
    male_price: number;
    female_price: number;
    remaining_slots: number;
  } | null;

  if (!batch) {
    return {
      success: false,
      message: 'Inscrições indisponíveis no momento',
      unavailable: true,
    };
  }

  const inventory = (inventoryData ?? []).map((item) => ({
    shirt_type: String(item.shirt_type),
    shirt_size: String(item.shirt_size),
    available_quantity: Number(item.total_quantity ?? 0) - Number(item.reserved_quantity ?? 0) - Number(item.delivered_quantity ?? 0),
  }));

  const categories: FormContext['categories'] = (categoriesData ?? []).map((item: {
    id: string;
    name: string;
    slug: string;
    capacity: number | null;
    available_slots: number | null;
    is_active: boolean;
  }) => ({
    id: String(item.id),
    name: String(item.name),
    slug: String(item.slug),
    capacity: item.capacity === null || item.capacity === undefined ? null : Number(item.capacity),
    available_slots: item.available_slots === null || item.available_slots === undefined ? null : Number(item.available_slots),
    is_active: Boolean(item.is_active),
  }));

  const activeCategories = categories.filter((category) => category.is_active);

  const kitItems: FormContext['kit_items'] = (kitItemsData ?? []).map((item: {
    id: string;
    name: string;
    slug: string;
    item_type: string;
    quantity_per_participant: number;
    requires_variant: boolean;
    is_required: boolean;
    is_active: boolean;
  }) => ({
    id: String(item.id),
    name: String(item.name),
    slug: String(item.slug),
    item_type: String(item.item_type),
    quantity_per_participant: Number(item.quantity_per_participant ?? 1),
    requires_variant: Boolean(item.requires_variant),
    is_required: Boolean(item.is_required),
    is_active: Boolean(item.is_active),
  }));

  const hasShirtItem = Boolean(kitItems.find((item) => item.is_active && item.item_type === 'shirt'));

  if (activeCategories.length === 0) {
    return {
      success: false,
      message: 'Nenhuma categoria de acesso ativa para o evento.',
      unavailable: true,
    };
  }

  return {
    success: true,
    context: {
      active_event_id: activeEvent.id,
      active_event_name: String(activeEvent.name ?? 'Evento selecionado'),
      kit_enabled: Boolean(activeEvent.kit_enabled),
      registration_enabled: Boolean(activeEvent.registration_enabled),
      has_shirt_item: hasShirtItem,
      batch_name: String(batch.batch_name),
      male_price: Number(batch.male_price ?? 0),
      female_price: Number(batch.female_price ?? 0),
      remaining_slots: Number(batch.remaining_slots ?? 0),
      inventory,
      categories: activeCategories,
      kit_items: kitItems.filter((item) => item.is_active),
    } satisfies FormContext,
  };
}

export async function getPricingPreviewAction(payload: { event_id: string; gender: string; ticket_category_id: string; coupon_code?: string }) {
  const supabase = await createServerSupabaseClient();
  const gender = payload.gender?.trim() ?? '';

  if (!gender) {
    return { success: false, message: 'Selecione o sexo para calcular o preco.' };
  }

  const { data: activeEvent, error: eventError } = await supabase
    .from('events')
    .select('id')
    .eq('id', payload.event_id)
    .is('archived_at', null)
    .maybeSingle();
  if (eventError || !activeEvent?.id) {
    return { success: false, message: eventError?.message ?? 'Nenhum evento ativo encontrado.' };
  }

  const { data, error } = await supabase.rpc('get_registration_pricing_preview', {
    p_gender: gender,
    p_coupon_code: payload.coupon_code?.trim() || null,
    p_event_id: activeEvent.id,
    p_ticket_category_id: payload.ticket_category_id,
  });

  if (error) {
    if ((error.message ?? '').toLowerCase().includes('preco nao configurado')) {
      return { success: false, message: 'Preço não configurado para esta categoria e lote.' };
    }

    return { success: false, message: error.message };
  }

  const preview = (Array.isArray(data) ? data[0] : data) as PricingPreview | null;
  if (!preview?.batch_id) {
    return { success: false, message: 'Nao foi possivel calcular o preco para este lote.' };
  }

  return {
    success: true,
    message: preview.coupon_message ?? 'Preco calculado com sucesso.',
    pricing: {
      batch_id: String(preview.batch_id),
      batch_name: String(preview.batch_name),
      sequence_number: Number(preview.sequence_number ?? 0),
      base_amount: Number(preview.base_amount ?? 0),
      discount_amount: Number(preview.discount_amount ?? 0),
      final_amount: Number(preview.final_amount ?? 0),
      remaining_slots: Number(preview.remaining_slots ?? 0),
      coupon_type: preview.coupon_type ? String(preview.coupon_type) : null,
      discount_percent: Number(preview.discount_percent ?? 0),
    },
  };
}

export async function validateCouponAction(payload: { event_id: string; code: string; gender: string; ticket_category_id: string }) {
  const code = payload.code.trim();
  if (!code) {
    return { success: false, message: 'Informe um codigo para validar.' };
  }

  return getPricingPreviewAction({ event_id: payload.event_id, gender: payload.gender, ticket_category_id: payload.ticket_category_id, coupon_code: code });
}

export async function createRegistrationAction(eventId: string, values: RegistrationFormValues, batchId: string) {
  const supabase = await createServerSupabaseClient();
  const cpf = removeCpfMask(values.cpf);
  const birthDateIso = toISODateFromBR(values.birth_date);
  const email = values.email.trim().toLowerCase();

  if (!birthDateIso) {
    return { success: false, message: 'Informe uma data válida no formato dd/MM/aaaa.' };
  }

  if (!email) {
    return { success: false, message: "E-mail e obrigatorio." };
  }

  const { data: activeEvent, error: activeEventError } = await supabase
    .from('events')
    .select('id, name, kit_enabled, organization_id')
    .eq('id', eventId)
    .is('archived_at', null)
    .maybeSingle();

  if (activeEventError || !activeEvent?.id) {
    return { success: false, message: activeEventError?.message ?? 'Nenhum evento ativo encontrado.' };
  }

  const couponCode = values.coupon_code?.trim() ?? '';

  const { data: existingContact, error: contactError } = await supabase
    .from('registration_contacts')
    .select('id,public_pin')
    .eq('organization_id', String(activeEvent.organization_id))
    .eq('cpf', cpf)
    .maybeSingle();
  if (contactError) return { success: false, message: 'Não foi possível validar a titularidade desta pessoa.' };
  if (existingContact?.id) {
    try {
      const holderState = await registrationContactHasActiveTicket(supabase, String(activeEvent.id), String(existingContact.id));
      if (holderState.hasActiveTicket) {
        return {
          success: false,
          requiresHolderDecision: true,
          message: 'Esta pessoa já é titular de outro ingresso neste evento. Cancele ou use Emitir ingresso para emitir sem titular.',
          issueWithoutHolderHref: `/ingressos/emitir?pin=${encodeURIComponent(String(existingContact.public_pin ?? ''))}`,
        };
      }
    } catch {
      return { success: false, message: 'Não foi possível validar a titularidade desta pessoa.' };
    }
  }

  try {
    if (!batchId) {
      return { success: false, message: 'Lote não resolvido. Calcule o preço novamente antes de emitir.' };
    }

    const { data, error: createError } = await supabase.rpc('create_manual_registration_order', {
      p_event_id: activeEvent.id,
      p_ticket_category_id: values.ticket_category_id,
      p_batch_id: batchId,
      p_full_name: values.full_name.trim(),
      p_cpf: cpf,
      p_birth_date: birthDateIso,
      p_gender: values.gender || null,
      p_phone: values.phone.replace(/\D/g, ''),
      p_email: email,
      p_city: values.city?.trim() || null,
      p_shirt_type: values.shirt_type?.trim() || null,
      p_shirt_size: values.shirt_size?.trim() || null,
      p_notes: values.notes?.trim() || null,
      p_payment_method: values.payment_method,
    });

    if (createError) {
      throw createError;
    }

    const created = (Array.isArray(data) ? data[0] : data) as RegistrationCreated | null;
    if (!created?.participant_id) {
      return { success: false, message: 'Reserva não criada: retorno inválido da inscrição.' };
    }

    return {
      success: true,
      message: 'Inscrição criada com sucesso',
      registration: {
        id: String(created.participant_id),
        order_id: String(created.order_id),
        order_item_id: String(created.order_item_id),
        payment_id: String(created.payment_id),
        ticket_id: created.ticket_id ? String(created.ticket_id) : null,
        full_name: String(created.full_name),
        event_name: String(activeEvent.name ?? 'Evento selecionado'),
        batch_name: String(created.batch_name),
        base_amount: Number(created.base_amount ?? 0),
        discount_amount: Number(created.discount_amount ?? 0),
        final_amount: Number(created.final_amount ?? 0),
        coupon_code: couponCode || null,
        payment_status: String(created.payment_status ?? 'pending'),
        reservation_expires_at: created.reservation_expires_at ? String(created.reservation_expires_at) : null,
        shirt_type: String(created.shirt_type),
        shirt_size: String(created.shirt_size),
      },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    const normalized = rawMessage.toLowerCase();

    if (normalized.includes('estoque indisponivel') || normalized.includes('estoque nao encontrado')) {
      return { success: false, message: 'Este modelo/tamanho está sem estoque no momento.' };
    }

    if (normalized.includes('inscricoes encerradas') || normalized.includes('nenhum lote ativo')) {
      return { success: false, message: 'Inscrições indisponíveis no momento.' };
    }

    if (normalized.includes('preco nao configurado')) {
      return { success: false, message: 'Preço não configurado para esta categoria e lote.' };
    }

    if (normalized.includes('cupom')) {
      return { success: false, message: rawMessage || 'Cupom inválido ou indisponível para este lote.' };
    }

    return {
      success: false,
      message: rawMessage || 'Não foi possível criar a inscrição.',
    };
  }
}

function mapPayment(details: unknown): ParticipantPaymentDetails | null {
  const row = (Array.isArray(details) ? details[0] : details) as Record<string, unknown> | null;
  if (!row?.payment_id) return null;

  return {
    payment_id: String(row.payment_id),
    participant_id: String(row.participant_id),
    event_id: String(row.event_id),
    event_name: row.event_name ? String(row.event_name) : null,
    amount: Number(row.amount ?? 0),
    discount_amount: Number(row.discount_amount ?? 0),
    final_amount: Number(row.final_amount ?? 0),
    payment_method: row.payment_method ? String(row.payment_method) : null,
    payment_status: String(row.payment_status ?? 'pending'),
    pix_code: row.pix_code ? String(row.pix_code) : null,
    pix_qrcode: row.pix_qrcode ? String(row.pix_qrcode) : null,
    gateway_payment_id: row.gateway_payment_id ? String(row.gateway_payment_id) : null,
    expires_at: row.expires_at ? String(row.expires_at) : null,
    paid_at: row.paid_at ? String(row.paid_at) : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export async function getParticipantPaymentAction(participantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_participant_payment_details', {
    p_participant_id: participantId,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const payment = mapPayment(data);
  if (!payment) {
    return { success: false, message: 'Pagamento não encontrado para este participante.' };
  }

  return { success: true, payment };
}

export async function generatePixPaymentAction(participantId: string) {
  const current = await getParticipantPaymentAction(participantId);
  if (!current.success || !current.payment) {
    return { success: false, message: current.message ?? 'Pagamento não encontrado.' };
  }

  if (current.payment.payment_status === 'paid') {
    return { success: false, message: 'Pagamento já está confirmado.' };
  }

  const payload = await paymentProvider.createPix({
    participantId,
    amount: current.payment.final_amount,
    expiresInMinutes: 120,
  });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('start_payment_pix', {
    p_participant_id: participantId,
    p_pix_code: payload.pixCode,
    p_pix_qrcode: payload.pixQrCode,
    p_gateway_payment_id: payload.gatewayPaymentId,
    p_expires_at: payload.expiresAt,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const payment = mapPayment(data);
  if (!payment) {
    return { success: false, message: 'Falha ao gerar dados de PIX.' };
  }

  return { success: true, message: 'PIX gerado com sucesso.', payment };
}

export async function simulatePaymentAction(participantId: string, method: 'pix' | 'credit_card') {
  await paymentProvider.confirmPayment({ participantId, method });

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('simulate_payment_paid', {
    p_participant_id: participantId,
    p_payment_method: method,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const updated = await getParticipantPaymentAction(participantId);
  return {
    success: updated.success,
    message: updated.success ? 'Pagamento confirmado com sucesso.' : updated.message,
    payment: updated.success ? updated.payment : null,
  };
}

export async function cancelRegistrationPaymentAction(participantId: string) {
  await paymentProvider.cancelPayment({ participantId, reason: 'Cancelado manualmente na tela de inscrição.' });

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('cancel_registration_payment', {
    p_participant_id: participantId,
    p_reason: 'Cancelado manualmente na tela de inscrição.',
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const updated = await getParticipantPaymentAction(participantId);
  return {
    success: updated.success,
    message: updated.success ? 'Pagamento cancelado com sucesso.' : updated.message,
    payment: updated.success ? updated.payment : null,
  };
}
