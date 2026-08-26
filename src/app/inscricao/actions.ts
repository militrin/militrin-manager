'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isValidCpf, removeCpfMask } from '@/lib/validation/registration';
import { getPaymentProvider } from '@/lib/payments/get-provider';
import { cancelPendingExternalCharge } from '@/lib/payments/cancel-stale-charges';
import { getPaymentGatewayProvider, getPaymentGatewayProviderName } from '@/lib/payments/get-gateway-provider';
import { todayAsPixDueDate } from '@/lib/payments/pix-due-date';
import { toISODateFromBR } from '@/lib/utils/date';
import { calculateAgeAtEventDate, formatDateBR, isMinimumAgeSatisfied } from '@/lib/utils/date';
import { getEmailProvider } from '@/lib/email/fake-provider';
import { getFirstAccessFlags } from '@/lib/account/first-access';
import { canAccessAdministrativePanel } from '@/lib/admin/panel-access';
import { resolvePostAuthDestination, sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
import { describeZeroPaymentReason, normalizePricingGenderInput, resolvePricingGender } from '@/lib/checkout/pricing';
import { buyerOwnershipModes, registrationContactHasActiveTicket, shouldAssignBuyerToNewOrder } from '@/lib/registrations/active-ticket-holder';
import { ACCOUNT_NOT_CONFIRMED_MESSAGE, isEmailConfirmed } from '@/lib/account/email-confirmation';
import { appBaseUrl } from '@/lib/urls/app-base-url';
import { createPasswordRecoveryState, verifyPasswordRecoveryState } from '@/lib/account/password-recovery-state';

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

type CheckoutPaymentMethod = 'pix' | 'credit_card_single' | 'credit_card_installments';

type RegistrationCreateInput = {
  event_id: string;
  ticket_category_id: string;
  full_name: string;
  cpf: string;
  birth_date: string;
  gender: string;
  phone: string;
  email: string;
  city?: string;
  shirt_type?: string;
  shirt_size?: string;
  payment_method: CheckoutPaymentMethod;
  coupon_code?: string;
  notes?: string;
  client_request_id?: string;
};

type MultiOrderItemInput = {
  pricing_gender?: 'male' | 'female';
  price_gender?: 'male' | 'female';
  shirt_type?: string;
  shirt_size?: string;
  ownership_status?: 'unassigned' | 'assigned';
  ownership_mode?: 'self' | 'unassigned' | 'named';
  holder_full_name?: string;
  holder_registration_contact_id?: string;
  holder_cpf?: string;
  holder_email?: string;
  holder_phone?: string;
};

type MultiOrderCreateInput = {
  event_id: string;
  ticket_category_id: string | null;
  quantity: number;
  gender?: string;
  shirt_type?: string;
  shirt_size?: string;
  payment_method: CheckoutPaymentMethod;
  coupon_code?: string;
  notes?: string;
  client_request_id?: string;
  assign_first_to_buyer?: boolean;
  items?: MultiOrderItemInput[];
  buyer: {
    full_name: string;
    cpf: string;
    birth_date: string;
    gender: string;
    phone: string;
    email: string;
    city: string;
  };
};

type SignupActionResult =
  | {
      success: true;
      user_id: string;
      email: string;
      email_confirmation_required: boolean;
      authenticated: boolean;
      profile_warning?: string;
      first_access_required?: boolean;
      redirect_to?: string;
      profile_creation_failed?: boolean;
    }
  | {
      success: false;
      message: string;
      code?: string;
    };

const paymentProvider = getPaymentProvider();
const emailProvider = getEmailProvider();

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function normalizeBirthDateInput(value: string | null | undefined) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(normalized)) {
    return toISODateFromBR(normalized);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  return null;
}

function isoToDateBR(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function translateAuthErrorMessage(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('invalid login credentials')) {
    return 'E-mail ou senha inválidos.';
  }
  if (normalized.includes('email not confirmed') || normalized.includes('email confirmation')) {
    return 'E-mail não confirmado. Verifique sua caixa de entrada antes de continuar.';
  }
  if (normalized.includes('user not found')) {
    return 'Usuário não encontrado.';
  }
  if (normalized.includes('email signups are disabled')) {
    return 'Cadastro por e-mail está desativado no momento.';
  }
  if (normalized.includes('email rate limit exceeded')) {
    return 'Muitas solicitações de e-mail foram realizadas em pouco tempo. Aguarde alguns minutos e tente novamente.';
  }
  if (normalized.includes('too many requests') && normalized.includes('email')) {
    return 'Muitas solicitações de e-mail foram realizadas em pouco tempo. Aguarde alguns minutos e tente novamente.';
  }
  if (normalized.includes('already registered')) {
    return 'E-mail já cadastrado.';
  }
  if (normalized.includes('invalid email')) {
    return 'Informe um e-mail válido.';
  }
  if (normalized.includes('email address') && normalized.includes('is invalid')) {
    return 'Informe um e-mail válido.';
  }
  if (normalized.includes('weak password')) {
    return 'A senha informada é muito fraca. Use outra combinação.';
  }
  return message;
}

function translateAuthErrorCode(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('invalid login credentials')) return 'invalid_credentials';
  if (normalized.includes('email not confirmed') || normalized.includes('email confirmation')) return 'email_not_confirmed';
  if (normalized.includes('user not found')) return 'user_not_found';
  if (normalized.includes('email signups are disabled')) return 'email_signups_disabled';
  if (normalized.includes('email rate limit exceeded')) return 'rate_limit';
  if (normalized.includes('too many requests') && normalized.includes('email')) return 'rate_limit';
  if (normalized.includes('already registered')) return 'EMAIL_ALREADY_REGISTERED';
  if (normalized.includes('invalid email')) return 'invalid_email';
  if (normalized.includes('email address') && normalized.includes('is invalid')) return 'invalid_email';
  if (normalized.includes('weak password')) return 'weak_password';

  return 'unknown';
}

function translateSignupCode(message: string) {
  return translateAuthErrorCode(message);
}

function isCpfAlreadyLinkedError(error: { message: string; details?: string | null }) {
  if (error.message === 'CPF_ALREADY_LINKED_TO_ANOTHER_USER') return true;
  if (!error.details) return false;
  try {
    const parsed = JSON.parse(error.details) as { code?: string };
    return parsed?.code === 'CPF_ALREADY_LINKED_TO_ANOTHER_USER';
  } catch {
    return false;
  }
}

function accountOrdersUrl() {
  return `${appBaseUrl()}/minha-conta/compras`;
}

function normalizeCheckoutPaymentMethod(value: unknown): CheckoutPaymentMethod | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'pix') return 'pix';
  if (normalized === 'credit_card_single') return 'credit_card_single';
  if (normalized === 'credit_card_installments') return 'credit_card_installments';
  if (normalized === 'credit_card') return 'credit_card_single';
  return null;
}

function toDbPaymentMethod(value: CheckoutPaymentMethod): 'pix' | 'credit_card' {
  return value === 'pix' ? 'pix' : 'credit_card';
}

async function getEventPaymentMethodsConfig(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventId: string,
) {
  const { data, error } = await supabase.rpc('get_event_payment_methods_setup', {
    p_event_id: eventId,
  });

  if (error) {
    return {
      success: false as const,
      message: error.message,
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return {
    success: true as const,
    config: {
      pix_enabled: Boolean(row?.pix_enabled ?? true),
      credit_card_single_enabled: Boolean(row?.credit_card_single_enabled ?? true),
      credit_card_installments_enabled: Boolean(row?.credit_card_installments_enabled ?? true),
    },
  };
}

async function getEventMinAgeRule(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventId: string,
) {
  const { data } = await supabase.from('events').select('min_age, starts_at').eq('id', eventId).maybeSingle();
  return { minAge: Number(data?.min_age ?? 18), eventStartsAt: data?.starts_at ?? null };
}

// Fonte única da mensagem de bloqueio por idade mínima -- usada nos dois
// pontos de validação do checkout público (registro simples e multi-item).
// minAgeSatisfied === null significa que não foi possível decidir (evento
// sem starts_at válido) -- nunca deixamos passar silenciosamente nesse caso.
function buildMinAgeMessage(minAge: number, birthDateIso: string, eventStartsAt: string | null) {
  if (!eventStartsAt) {
    return 'Não foi possível confirmar a idade mínima porque a data do evento não está configurada. Entre em contato com o suporte.';
  }
  const ageAtEvent = calculateAgeAtEventDate(birthDateIso, eventStartsAt);
  const eventDateLabel = formatDateBR(eventStartsAt);
  const ageClause = ageAtEvent !== null ? ` Você terá ${ageAtEvent} anos em ${eventDateLabel}.` : '';
  return `Este evento exige idade mínima de ${minAge} anos na data do evento (${eventDateLabel}).${ageClause}`;
}

function isMethodAllowedByConfig(
  method: CheckoutPaymentMethod,
  config: {
    pix_enabled: boolean;
    credit_card_single_enabled: boolean;
    credit_card_installments_enabled: boolean;
  },
) {
  if (method === 'pix') return config.pix_enabled;
  if (method === 'credit_card_single') return config.credit_card_single_enabled;
  if (method === 'credit_card_installments') return config.credit_card_installments_enabled;
  return false;
}

function firstAccessRouteWithNext(nextPath: string) {
  const safeNext = sanitizePostFirstAccessNextPath(nextPath, '/minha-conta');
  return `/primeiro-acesso?next=${encodeURIComponent(safeNext)}`;
}

async function resolvePostAuthPath(params: {
  userId: string;
  authEmail?: string | null;
  emailConfirmed: boolean;
  nextPath?: string | null;
  wizardPath?: string | null;
}) {
  const administrativeAccess = await canAccessAdministrativePanel(params.userId);
  const destination = resolvePostAuthDestination({
    nextPath: params.nextPath,
    wizardPath: params.wizardPath,
    fallback: administrativeAccess ? '/painel' : '/minha-conta',
  });

  // Gate mais fundamental que qualquer outro (bloqueio, perfil incompleto):
  // sem e-mail confirmado, a conta nao anda pra frente em lugar nenhum.
  // Isso normalmente nem chega a rodar (o Supabase Auth ja recusa sessao
  // pra login/signup nao confirmado quando "Confirm email" esta ligado) --
  // e so a rede de seguranca canonica caso uma sessao exista mesmo assim
  // (ex.: conta criada via Admin API sem confirmar).
  if (!params.emailConfirmed) {
    return {
      destination,
      isBlocked: false,
      firstAccessRequired: false,
      emailConfirmationRequired: true,
      redirectTo: `/verifique-seu-email?email=${encodeURIComponent(params.authEmail ?? '')}`,
    };
  }

  const flags = await getFirstAccessFlags(params.userId, params.authEmail ?? null);
  const isBlocked = flags.isBlocked;
  const firstAccessRequired = !isBlocked && flags.firstAccessRequired;
  const redirectTo = isBlocked
    ? '/acesso-negado'
    : (firstAccessRequired ? firstAccessRouteWithNext(destination) : destination);

  return {
    destination,
    isBlocked,
    firstAccessRequired,
    emailConfirmationRequired: false,
    redirectTo,
  };
}

async function upsertCustomerProfileForUser(params: {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  userId: string;
  fullName: string;
  cpf?: string | null;
  birthDate?: string | null;
  gender?: string | null;
  phone?: string | null;
  email: string;
  city?: string | null;
  loyaltyTierId?: string | null;
}) {
  const { error } = await upsertCustomerProfileCompat(params.supabase, {
    userId: params.userId,
    fullName: params.fullName,
    cpf: params.cpf ?? null,
    birthDate: params.birthDate ?? null,
    gender: params.gender ?? null,
    phone: params.phone ?? null,
    email: params.email,
    city: params.city ?? null,
    loyaltyTierId: params.loyaltyTierId ?? null,
    loyaltyOverride: false,
    loyaltyOverrideReason: null,
    showInParticipantList: true,
    allowFriendRequests: true,
    profileVisibility: 'participants',
  });

  if (error) {
    throw error;
  }
}

async function getNovatoTierId(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>) {
  const { data } = await supabase
    .from('loyalty_tiers')
    .select('id')
    .eq('slug', 'novato')
    .maybeSingle();

  return data?.id ? String(data.id) : null;
}

async function ensureCustomerProfileForSignedUser(params: {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  userId: string;
  email: string;
  fallback?: {
    full_name?: string;
    cpf?: string;
    birth_date?: string;
    gender?: string;
    phone?: string;
    city?: string;
  };
}) {
  const { data: profileData, error: profileError } = await params.supabase.rpc('get_customer_profile', {
    p_user_id: params.userId,
  });
  if (profileError) {
    return { success: false as const, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;

  const fullName = String(
    profile?.full_name
    ?? params.fallback?.full_name
    ?? 'Participante',
  ).trim();

  const cpf = String(profile?.cpf ?? params.fallback?.cpf ?? '').replace(/\D/g, '') || null;
  const birthDate = normalizeBirthDateInput(String(profile?.birth_date ?? params.fallback?.birth_date ?? ''));
  const gender = String(profile?.gender ?? params.fallback?.gender ?? '').trim() || null;
  const phone = String(profile?.phone ?? params.fallback?.phone ?? '').replace(/\D/g, '') || null;
  const city = String(profile?.city ?? params.fallback?.city ?? '').trim() || null;
  const email = normalizeEmail(params.email);

  if (!email) {
    return { success: false as const, message: 'Conta sem e-mail válido. Atualize o e-mail para continuar.' };
  }

  const missingRequiredFields = [
    !cpf ? 'CPF' : null,
    !birthDate ? 'nascimento' : null,
    !gender ? 'gênero' : null,
    !phone ? 'telefone' : null,
    !city ? 'cidade' : null,
  ].filter(Boolean) as string[];

  try {
    await upsertCustomerProfileForUser({
      supabase: params.supabase,
      userId: params.userId,
      fullName,
      cpf,
      birthDate,
      gender,
      phone,
      email,
      city,
      loyaltyTierId: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : await getNovatoTierId(params.supabase),
    });
  } catch (error) {
    return {
      success: false as const,
      message: error instanceof Error ? error.message : 'Não foi possível criar/atualizar o perfil do participante.',
    };
  }

  const { error: contactError } = await params.supabase.rpc('ensure_registration_contact_for_user', {
    p_user_id: params.userId,
  });
  let contactWarning: string | null = null;
  if (contactError) {
    console.warn('[auth-profile] Falha ao materializar cadastro global', {
      userId: params.userId,
      message: contactError.message,
    });
    if (isCpfAlreadyLinkedError(contactError)) {
      // Nao bloqueia login/sessao (a conta ja existe e e legitima) -- so
      // avisa por que /cadastros nao mostra um Cadastro proprio pra ela.
      contactWarning = 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.';
    }
  }

  if (missingRequiredFields.length > 0) {
    console.warn('[auth-profile] Perfil incompleto para usuário autenticado', {
      userId: params.userId,
      missingRequiredFields,
    });

    return {
      success: true as const,
      warning: `Seu perfil foi iniciado, mas faltam dados obrigatórios: ${missingRequiredFields.join(', ')}. Complete em Meus dados.`,
    };
  }

  return { success: true as const, warning: contactWarning };
}

function mapPayment(row: Record<string, unknown>) {
  return {
    payment_id: String(row.payment_id ?? ''),
    participant_id: String(row.participant_id ?? ''),
    event_id: String(row.event_id ?? ''),
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
  };
}

function mapOrderPayment(row: Record<string, unknown>) {
  return {
    payment_id: String(row.payment_id ?? ''),
    order_id: String(row.order_id ?? ''),
    event_id: String(row.event_id ?? ''),
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
  };
}

async function getOrderSnapshotByOrderId(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  orderId: string,
) {
  const { data, error } = await supabase.rpc('get_order_checkout_snapshot', {
    p_order_id: orderId,
  });

  if (error) return { success: false as const, message: error.message };
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    return { success: false as const, message: 'Pedido nao encontrado.' };
  }

  const first = rows[0];
  const items = rows.map((row, index) => ({
    item_id: String(row.item_id ?? ''),
    item_position: Number(row.item_position ?? index + 1),
    item_status: String(row.item_status ?? 'reserved'),
    ownership_status: String(row.ownership_status ?? 'unassigned'),
    pricing_gender: row.pricing_gender ? String(row.pricing_gender) : null,
    participant_id: row.participant_id ? String(row.participant_id) : null,
    participant_name: row.participant_name ? String(row.participant_name) : null,
    holder_full_name: row.holder_full_name ? String(row.holder_full_name) : null,
    ticket_id: row.ticket_id ? String(row.ticket_id) : null,
    ticket_status: row.ticket_status ? String(row.ticket_status) : null,
    ticket_token: row.ticket_token ? String(row.ticket_token) : null,
    shirt_type: row.shirt_type ? String(row.shirt_type) : null,
    shirt_size: row.shirt_size ? String(row.shirt_size) : null,
    category_name: row.category_name ? String(row.category_name) : null,
    batch_name: row.batch_name ? String(row.batch_name) : null,
    titular_display: row.participant_name
      ? String(row.participant_name)
      : (row.holder_full_name ? String(row.holder_full_name) : 'Titular ainda nao definido'),
  }));

  const firstTicket = items.find((item) => item.ticket_token) ?? items[0] ?? null;

  return {
    success: true as const,
    snapshot: {
      order_id: String(first.order_id ?? ''),
      order_number: first.order_number ? String(first.order_number) : null,
      order_status: String(first.order_status ?? 'pending'),
      event_id: String(first.event_id ?? ''),
      event_name: first.event_name ? String(first.event_name) : null,
      payment: {
        payment_id: String(first.payment_id ?? ''),
        order_id: String(first.order_id ?? ''),
        amount: Number(first.amount ?? 0),
        discount_amount: Number(first.discount_amount ?? 0),
        final_amount: Number(first.final_amount ?? 0),
        payment_method: first.payment_method ? String(first.payment_method) : null,
        payment_status: String(first.payment_status ?? 'pending'),
        expires_at: first.expires_at ? String(first.expires_at) : null,
        pix_code: first.pix_code ? String(first.pix_code) : null,
        pix_qrcode: first.pix_qrcode ? String(first.pix_qrcode) : null,
        gateway_payment_id: first.gateway_payment_id ? String(first.gateway_payment_id) : null,
        paid_at: first.paid_at ? String(first.paid_at) : null,
      },
      items,
      item_count: items.length,
      qr_token: firstTicket?.ticket_token ?? null,
    },
  };
}

export type UnifiedOrderItem = {
  order_item_id: string;
  item_kind: 'ticket' | 'product';
  status: string;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  final_amount: number;
  item_position: number | null;
  category_name: string | null;
  batch_name: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  holder_full_name: string | null;
  participant_id: string | null;
  participant_name: string | null;
  ticket_id: string | null;
  ticket_status: string | null;
  ticket_token: string | null;
  ownership_status: string | null;
  titular_display: string;
  store_item_id: string | null;
  store_item_name: string | null;
  store_item_image_url: string | null;
  store_item_variant_id: string | null;
  variant_name: string | null;
  variant_value: string | null;
};

// Fonte canonica de itens de kit (camiseta inclusa): tabela participant_kit_items,
// a MESMA usada por Central de Operacoes, ficha do ingresso e
// src/app/minha-conta/ingressos/[ticketId]/itens/page.tsx -- nenhuma segunda
// logica de kit criada para o checkout. 'cancelled' nunca aparece aqui (ja
// filtrado na consulta): item cancelado nao e um item ativo do kit.
export type UnifiedOrderKitItem = {
  id: string;
  kit_item_id: string;
  ticket_id: string | null;
  item_name: string;
  item_type: string;
  status: 'reserved' | 'confirmed' | 'delivered';
  variant_label: string | null;
  delivered_at: string | null;
};

export type UnifiedOrderSnapshot = {
  order_id: string;
  order_number: string | null;
  order_status: string;
  event_id: string;
  event_name: string | null;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  applied_coupon_code: string | null;
  payment: {
    payment_id: string;
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
  };
  items: UnifiedOrderItem[];
  kit_items: UnifiedOrderKitItem[];
};

/**
 * Fonte canonica unica pra ingresso+produto do mesmo pedido: le
 * get_cart_order_details (o MESMO RPC ja usado pelo CartStep), nunca
 * recalcula nada aqui -- so remapeia o jsonb pro shape que o wizard usa nas
 * etapas de Pagamento e Concluido. Substitui getOrderSnapshotByOrderId (que
 * usa get_order_checkout_snapshot, escopado a item_kind='ticket') nesses dois
 * pontos -- ver 20260837000000_unified_order_payment_snapshot.sql.
 */
async function getUnifiedOrderSnapshot(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  orderId: string,
) {
  const { data, error } = await supabase.rpc('get_cart_order_details', { p_order_id: orderId });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };

  const raw = data as Record<string, unknown>;
  const rawItems = (Array.isArray(raw.items) ? raw.items : []) as Array<Record<string, unknown>>;
  const rawPayment = raw.payment as Record<string, unknown> | null;

  const items: UnifiedOrderItem[] = rawItems.map((row, index) => {
    const participantName = row.participant_name ? String(row.participant_name) : null;
    const holderName = row.holder_full_name ? String(row.holder_full_name) : null;
    return {
      order_item_id: String(row.order_item_id ?? ''),
      item_kind: row.item_kind === 'product' ? 'product' : 'ticket',
      status: String(row.status ?? 'reserved'),
      quantity: Number(row.quantity ?? 1),
      unit_price: Number(row.unit_price ?? 0),
      discount_amount: Number(row.discount_amount ?? 0),
      final_amount: Number(row.final_amount ?? 0),
      item_position: row.item_position !== null && row.item_position !== undefined ? Number(row.item_position) : index + 1,
      category_name: row.category_name ? String(row.category_name) : null,
      batch_name: row.batch_name ? String(row.batch_name) : null,
      shirt_type: row.shirt_type ? String(row.shirt_type) : null,
      shirt_size: row.shirt_size ? String(row.shirt_size) : null,
      holder_full_name: holderName,
      participant_id: row.participant_id ? String(row.participant_id) : null,
      participant_name: participantName,
      ticket_id: row.ticket_id ? String(row.ticket_id) : null,
      ticket_status: row.ticket_status ? String(row.ticket_status) : null,
      ticket_token: row.ticket_token ? String(row.ticket_token) : null,
      ownership_status: row.ownership_status ? String(row.ownership_status) : null,
      titular_display: participantName || holderName || 'Titular ainda não definido',
      store_item_id: row.store_item_id ? String(row.store_item_id) : null,
      store_item_name: row.store_item_name ? String(row.store_item_name) : null,
      store_item_image_url: row.store_item_image_url ? String(row.store_item_image_url) : null,
      store_item_variant_id: row.store_item_variant_id ? String(row.store_item_variant_id) : null,
      variant_name: row.variant_name ? String(row.variant_name) : null,
      variant_value: row.variant_value ? String(row.variant_value) : null,
    };
  });

  const paymentDefaults = {
    payment_id: '', amount: 0, discount_amount: 0, final_amount: 0, payment_method: null,
    payment_status: 'pending', pix_code: null, pix_qrcode: null, gateway_payment_id: null, expires_at: null, paid_at: null,
  };

  const ticketIds = items.map((item) => item.ticket_id).filter((id): id is string => Boolean(id));
  const kitItems = await getUnifiedOrderKitItems(supabase, ticketIds);

  return {
    success: true as const,
    snapshot: {
      order_id: String(raw.order_id ?? ''),
      order_number: raw.order_number ? String(raw.order_number) : null,
      order_status: String(raw.order_status ?? raw.status ?? 'pending'),
      event_id: String(raw.event_id ?? ''),
      event_name: raw.event_name ? String(raw.event_name) : null,
      base_amount: Number(raw.base_amount ?? 0),
      discount_amount: Number(raw.discount_amount ?? 0),
      final_amount: Number(raw.final_amount ?? 0),
      applied_coupon_code: raw.applied_coupon_code ? String(raw.applied_coupon_code) : null,
      payment: rawPayment
        ? {
            payment_id: String(rawPayment.payment_id ?? ''),
            amount: Number(rawPayment.amount ?? 0),
            discount_amount: Number(rawPayment.discount_amount ?? 0),
            final_amount: Number(rawPayment.final_amount ?? 0),
            payment_method: rawPayment.payment_method ? String(rawPayment.payment_method) : null,
            payment_status: String(rawPayment.payment_status ?? 'pending'),
            pix_code: rawPayment.pix_code ? String(rawPayment.pix_code) : null,
            pix_qrcode: rawPayment.pix_qrcode ? String(rawPayment.pix_qrcode) : null,
            gateway_payment_id: rawPayment.gateway_payment_id ? String(rawPayment.gateway_payment_id) : null,
            expires_at: rawPayment.expires_at ? String(rawPayment.expires_at) : null,
            paid_at: rawPayment.paid_at ? String(rawPayment.paid_at) : null,
          }
        : paymentDefaults,
      items,
      kit_items: kitItems,
    } satisfies UnifiedOrderSnapshot,
  };
}

/**
 * Fonte canonica de itens de kit/camiseta -- MESMA tabela e MESMO join usados
 * por src/app/minha-conta/ingressos/[ticketId]/itens/page.tsx (Minha Conta) e
 * pela Central de Operacoes (src/app/operacoes/actions.ts). Filtra por
 * ticket_id (nunca por participant_id/order_item_id aqui) porque e exatamente
 * a chave que a policy RLS participant_kit_items_ticket_owner_select usa para
 * o comprador (tickets.owner_user_id = auth.uid()) -- a mesma policy que ja
 * protege a pagina de Minha Conta. Sem corrida com a emissao do ticket: o
 * trigger que preenche participant_kit_items.ticket_id
 * (attach_order_item_kit_items_to_new_ticket) roda na MESMA transacao do
 * INSERT em tickets (confirm_order_item_and_issue_ticket), entao por definicao
 * ja terminou antes dessa transacao commitar e este SELECT (rodando depois,
 * em outra transacao) sempre ve o ticket_id ja vinculado.
 */
async function getUnifiedOrderKitItems(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  ticketIds: string[],
): Promise<UnifiedOrderKitItem[]> {
  if (ticketIds.length === 0) return [];

  const { data, error } = await supabase
    .from('participant_kit_items')
    .select('id, kit_item_id, ticket_id, variant_data, status, delivered_at, event_kit_items(name, item_type)')
    .in('ticket_id', ticketIds);

  if (error) {
    console.error('[checkout:kit-items] fetch_failed', { ticketIds, error: error.message });
    return [];
  }

  return (data ?? [])
    .filter((row) => row.status !== 'cancelled')
    .map((row) => {
      const eventKitItem = (Array.isArray(row.event_kit_items) ? row.event_kit_items[0] : row.event_kit_items) as
        | { name: string; item_type: string }
        | null;
      const variantData = (row.variant_data ?? {}) as Record<string, unknown>;
      const variantLabel = variantData.variant_name ?? variantData.variant_value ?? variantData.shirt_size ?? null;
      return {
        id: String(row.id),
        kit_item_id: String(row.kit_item_id),
        ticket_id: row.ticket_id ? String(row.ticket_id) : null,
        item_name: eventKitItem?.name ? String(eventKitItem.name) : 'Item do kit',
        item_type: eventKitItem?.item_type ? String(eventKitItem.item_type) : 'other',
        status: row.status as 'reserved' | 'confirmed' | 'delivered',
        variant_label: variantLabel ? String(variantLabel) : null,
        delivered_at: row.delivered_at ? String(row.delivered_at) : null,
      };
    });
}

// Reveridica um pedido persistido localmente (sessionStorage do wizard)
// contra o backend antes de ele ser restaurado como "carrinho atual" -- o
// cache local nunca e a fonte de verdade sobre status (pago/confirmado/
// cancelado podem ter mudado via webhook desde a ultima visita, e o
// order_id no localStorage/sessionStorage nao tem nenhum vinculo com QUAL
// usuario esta logado agora no navegador). get_cart_order_details ja exige
// v_order.user_id = auth.uid() (ou acesso de organizacao) -- um order_id de
// outro usuario simplesmente falha aqui com "Sem acesso a este pedido.",
// nunca vaza dados de outra conta.
export async function getPublicOrderSnapshotAction(orderId: string) {
  const supabase = await createServerSupabaseClient();
  return getUnifiedOrderSnapshot(supabase, orderId);
}

function relationName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0] as Record<string, unknown> | undefined;
    return first?.name ? String(first.name) : null;
  }
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return objectValue.name ? String(objectValue.name) : null;
  }
  return null;
}

function buildRequestScopedNotes(notes: string | undefined, requestId: string | undefined) {
  const base = notes?.trim() || 'Portal publico de inscricao';
  if (!requestId?.trim()) return base;
  return `${base} [checkout:${requestId.trim()}]`;
}

function toTextParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function toRequiredTextParam(value: unknown, fallback = ''): string {
  return toTextParam(value) ?? fallback;
}

type RpcMultiOrderItemPayload = {
  pricing_gender: 'male' | 'female' | null;
  shirt_type: string | null;
  shirt_size: string | null;
  ownership_status: 'assigned' | 'unassigned' | null;
  ownership_mode: 'self' | 'unassigned' | 'named' | null;
  holder_full_name: string | null;
  holder_registration_contact_id: string | null;
  holder_cpf: string | null;
  holder_email: string | null;
  holder_phone: string | null;
};

function normalizeMultiOrderItemsForRpc(items: MultiOrderItemInput[] | undefined): RpcMultiOrderItemPayload[] {
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const pricingGender = item.pricing_gender ?? item.price_gender;
    const normalizedGender = normalizePricingGenderInput(pricingGender);
    const normalizedOwnershipStatus = item.ownership_status === 'assigned' || item.ownership_status === 'unassigned'
      ? item.ownership_status
      : null;
    const normalizedOwnershipMode = item.ownership_mode === 'self' || item.ownership_mode === 'unassigned' || item.ownership_mode === 'named'
      ? item.ownership_mode
      : null;

    return {
      pricing_gender: normalizedGender,
      shirt_type: toTextParam(item.shirt_type),
      shirt_size: toTextParam(item.shirt_size),
      ownership_status: normalizedOwnershipStatus,
      ownership_mode: normalizedOwnershipMode,
      holder_full_name: toTextParam(item.holder_full_name),
      holder_registration_contact_id: toTextParam(item.holder_registration_contact_id),
      holder_cpf: toTextParam(item.holder_cpf)?.replace(/\D/g, '') || null,
      holder_email: toTextParam(item.holder_email),
      holder_phone: toTextParam(item.holder_phone),
    };
  });
}

function summarizeInventoryAdjustments(items: RpcMultiOrderItemPayload[]) {
  const totals = new Map<string, number>();

  for (const item of items) {
    const shirtType = toTextParam(item.shirt_type);
    const shirtSize = toTextParam(item.shirt_size);
    if (!shirtType || !shirtSize) continue;

    const key = `${shirtType}::${shirtSize}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  return Array.from(totals.entries()).map(([key, requested_quantity]) => {
    const [shirt_type, shirt_size] = key.split('::');
    return { shirt_type, shirt_size, requested_quantity };
  });
}

function maskCpfForLog(cpf: string) {
  const normalized = cpf.replace(/\D/g, '');
  if (normalized.length <= 3) return normalized;
  return `${'*'.repeat(Math.max(0, normalized.length - 3))}${normalized.slice(-3)}`;
}

function translateRegistrationErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('cpf ja cadastrado')) return 'Este CPF ja esta inscrito neste evento.';
  if (normalized.includes('capacidade da categoria')) return 'Categoria esgotada para este evento.';
  if (normalized.includes('estoque insuficiente')) return 'Nao ha unidades suficientes deste tamanho para todos os ingressos selecionados.';
  if (normalized.includes('estoque indisponivel')) return 'Camiseta sem estoque para o modelo/tamanho selecionado.';
  if (normalized.includes('estoque nao encontrado')) return 'Camiseta indisponivel para o modelo/tamanho selecionado.';
  if (normalized.includes('inscricoes fechadas')) return 'As inscricoes para este evento estao encerradas.';
  if (normalized.includes('lotes esgotados') || normalized.includes('lote')) return 'Lote encerrado ou sem disponibilidade.';
  if (normalized.includes('holder_already_has_ticket_for_event') || normalized.includes('ja e titular de outro ingresso')) {
    return 'Você já possui um ingresso neste evento.';
  }
  if (normalized.includes('cupom')) return message;
  return message;
}

async function getRegistrationSnapshotByParticipantId(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  participantId: string,
  fallbackEventId: string,
) {
  const [{ data: paymentData, error: paymentError }, { data: participantData, error: participantError }, { data: ticketRows, error: ticketError }, { data: order }] = await Promise.all([
    supabase.rpc('get_participant_payment_details', { p_participant_id: participantId }),
    supabase
      .from('participants')
      .select('id, event_id, full_name, registration_status, reservation_status, reservation_expires_at, shirt_type, shirt_size, email, ticket_categories(name), registration_batches(name)')
      .eq('id', participantId)
      .single(),
    supabase
      .from('tickets')
      .select('id, token, order_items!inner(participant_id)')
      .eq('order_items.participant_id', participantId)
      .neq('status', 'cancelled')
      .limit(2),
    supabase.from('orders').select('id, order_number, status').eq('participant_id', participantId).maybeSingle(),
  ]);

  if (paymentError) return { success: false as const, message: paymentError.message };
  if (participantError) return { success: false as const, message: participantError.message };
  if (ticketError) return { success: false as const, message: ticketError.message };
  if ((ticketRows?.length ?? 0) > 1) {
    return { success: false as const, message: 'Mais de um ingresso encontrado para o participante; informe o ingresso explicitamente.' };
  }
  const ticket = ticketRows?.[0] ?? null;
  const { data: ticketKitData, error: ticketKitError } = ticket?.id
    ? await supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticket.id })
    : { data: [] as Array<Record<string, unknown>>, error: null };
  if (ticketKitError) return { success: false as const, message: ticketKitError.message };

  const paymentRow = (Array.isArray(paymentData) ? paymentData[0] : paymentData) as Record<string, unknown> | null;
  if (!paymentRow) return { success: false as const, message: 'Pagamento nao encontrado apos criar inscricao.' };

  return {
    success: true as const,
    snapshot: {
      participant_id: participantId,
      payment_id: String(paymentRow.payment_id ?? ''),
      final_amount: Number(paymentRow.final_amount ?? 0),
      payment_status: String(paymentRow.payment_status ?? 'pending'),
      expires_at: paymentRow.expires_at ? String(paymentRow.expires_at) : null,
      event_id: String(participantData.event_id ?? fallbackEventId),
      event_name: paymentRow.event_name ? String(paymentRow.event_name) : null,
      participant_name: String(participantData.full_name ?? ''),
      category_name: relationName(participantData.ticket_categories),
      batch_name: relationName(participantData.registration_batches),
      reservation_status: String(participantData.reservation_status ?? 'pending'),
      reservation_expires_at: participantData.reservation_expires_at ? String(participantData.reservation_expires_at) : null,
      shirt_type: participantData.shirt_type ? String(participantData.shirt_type) : null,
      shirt_size: participantData.shirt_size ? String(participantData.shirt_size) : null,
      payment: mapPayment(paymentRow),
      kit_items: (ticketKitData ?? []).map((item: Record<string, unknown>) => ({
        kit_item_id: String(item.kit_item_id ?? ''),
        item_name: String(item.item_name ?? ''),
        item_type: String(item.item_type ?? ''),
        quantity: Number(item.quantity ?? 1),
        status: String(item.status ?? 'reserved'),
        delivered_at: item.delivered_at ? String(item.delivered_at) : null,
        variant_data: item.variant_data ?? null,
      })),
      order_id: order?.id ? String(order.id) : null,
      order_number: order?.order_number ? String(order.order_number) : null,
      qr_token: ticket?.token ? String(ticket.token) : null,
    },
  };
}

async function syncOrderAndTicket(params: {
  participantId: string;
  userId: string;
  shouldIssueTicket: boolean;
}) {
  const supabase = await createServerSupabaseClient();

  const { error: orderError } = await supabase.rpc('ensure_order_for_participant', {
    p_participant_id: params.participantId,
    p_user_id: params.userId,
  });
  if (orderError) {
    return { success: false, message: orderError.message };
  }

  if (params.shouldIssueTicket) {
    const { error: ticketError } = await supabase.rpc('confirm_order_and_issue_ticket', {
      p_participant_id: params.participantId,
    });
    if (ticketError) {
      return { success: false, message: ticketError.message };
    }
  }

  return { success: true as const };
}

async function sendTransactionEmails(params: {
  participantId: string;
  paymentStatus: string;
  paymentMethod: string | null;
  finalAmount: number;
  email: string;
  fullName: string;
}) {
  const supabase = await createServerSupabaseClient();
  const [{ data: order }, { data: participant }, { data: ticket }, { data: kitItems }] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, event_id, created_at, final_amount, discount_amount, base_amount, events(name, starts_at, location), participant_id')
      .eq('participant_id', params.participantId)
      .maybeSingle(),
    supabase
      .from('participants')
      .select('id, event_id, full_name, ticket_categories(name)')
      .eq('id', params.participantId)
      .maybeSingle(),
    supabase
      .from('tickets')
      .select('id, token')
      .eq('participant_id', params.participantId)
      .maybeSingle(),
    Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const { data: ticketKitItems } = ticket?.id
    ? await supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticket.id })
    : { data: [] as Array<Record<string, unknown>> };

  if (params.paymentStatus === 'paid' && ticket?.token && order && participant) {
    const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
    await emailProvider.sendTicketConfirmation({
      to: params.email,
      participantName: params.fullName,
      eventName: String(eventObj?.name ?? 'Evento'),
      eventDate: eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null,
      eventLocation: eventObj?.location ? String(eventObj.location) : null,
      categoryName: relationName(participant.ticket_categories),
      kitItems: (ticketKitItems ?? kitItems ?? []).map((item: Record<string, unknown>) => ({
        name: String(item.item_name ?? ''),
        quantity: Number(item.quantity ?? 1),
      })),
      orderNumber: String(order.order_number),
      ticketToken: String(ticket.token),
      accountUrl: accountOrdersUrl(),
    });
    return;
  }

  await emailProvider.sendPaymentPending({
    to: params.email,
    participantName: params.fullName,
    amount: params.finalAmount,
    paymentMethod: params.paymentMethod ?? 'pix',
    expiresAt: null,
    pixCode: null,
  });
}

export async function getPublicSessionAction() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: true, authenticated: false, first_access_required: false, redirect_to: null as string | null };
  }

  const ensuredProfile = await ensureCustomerProfileForSignedUser({
    supabase,
    userId: user.id,
    email: user.email ?? '',
    fallback: {
      full_name: typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : undefined,
      cpf: typeof user.user_metadata?.cpf === 'string' ? user.user_metadata.cpf : undefined,
      birth_date: typeof user.user_metadata?.birth_date === 'string' ? user.user_metadata.birth_date : undefined,
      gender: typeof user.user_metadata?.gender === 'string' ? user.user_metadata.gender : undefined,
      phone: typeof user.user_metadata?.phone === 'string' ? user.user_metadata.phone : undefined,
      city: typeof user.user_metadata?.city === 'string' ? user.user_metadata.city : undefined,
    },
  });

  if (!ensuredProfile.success) {
    return {
      success: true,
      authenticated: true,
      first_access_required: true,
      redirect_to: '/primeiro-acesso',
      user: {
        id: user.id,
        email: user.email ?? null,
      },
      profile: null,
      profile_warning: 'Sua conta foi criada, mas precisamos concluir seus dados.',
    };
  }

  const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
    p_user_id: user.id,
  });
  if (profileError) {
    return { success: false, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const postAuth = await resolvePostAuthPath({
    userId: user.id,
    authEmail: user.email ?? null,
    emailConfirmed: isEmailConfirmed(user),
    nextPath: null,
    wizardPath: null,
  });

  return {
    success: true,
    authenticated: true,
    first_access_required: postAuth.firstAccessRequired,
    redirect_to: postAuth.redirectTo,
    user: {
      id: user.id,
      email: user.email ?? null,
    },
    profile: profile
      ? {
          full_name: profile.full_name ? String(profile.full_name) : '',
          cpf: profile.cpf ? String(profile.cpf) : '',
          birth_date: profile.birth_date ? String(profile.birth_date) : '',
          gender: profile.gender ? String(profile.gender) : '',
          phone: profile.phone ? String(profile.phone) : '',
          email: user.email ?? '',
          city: profile.city ? String(profile.city) : '',
          loyalty_tier_id: profile.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
          loyalty_tier_name: profile.loyalty_tier_name ? String(profile.loyalty_tier_name) : null,
          loyalty_tier_badge: profile.loyalty_tier_badge ? String(profile.loyalty_tier_badge) : null,
          loyalty_override: Boolean(profile.loyalty_override),
          show_in_participant_list: Boolean(profile.show_in_participant_list),
          allow_friend_requests: Boolean(profile.allow_friend_requests),
          profile_visibility: profile.profile_visibility ? String(profile.profile_visibility) : 'participants',
        }
      : null,
  };
}

export async function getPublicAccountEmailStatusAction(email: string) {
  const supabase = await createServerSupabaseClient();
  const normalized = normalizeEmail(email);
  if (!normalized) return { success: false, message: 'E-mail obrigatorio.' };

  const { data, error } = await supabase.rpc('get_public_account_email_status', {
    p_email: normalized,
  });

  if (error) return { success: false, message: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return { success: true, has_account: Boolean(row?.has_account) };
}

export async function signInPublicAccountAction(input: {
  email: string;
  password: string;
  next_path?: string | null;
  wizard_path?: string | null;
}) {
  const supabase = await createServerSupabaseClient();
  const normalized = normalizeEmail(input.email);
  if (!normalized || !input.password) {
    return { success: false, message: 'E-mail e senha são obrigatórios.' };
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalized,
      password: input.password,
    });

    if (error || !data.user) {
      const raw = error?.message ?? 'Não foi possível autenticar.';
      return { success: false, code: translateAuthErrorCode(raw), message: translateAuthErrorMessage(raw) };
    }

    const ensuredProfile = await ensureCustomerProfileForSignedUser({
      supabase,
      userId: data.user.id,
      email: data.user.email ?? normalized,
      fallback: {
        full_name: typeof data.user.user_metadata?.full_name === 'string' ? data.user.user_metadata.full_name : undefined,
        cpf: typeof data.user.user_metadata?.cpf === 'string' ? data.user.user_metadata.cpf : undefined,
        birth_date: typeof data.user.user_metadata?.birth_date === 'string' ? data.user.user_metadata.birth_date : undefined,
        gender: typeof data.user.user_metadata?.gender === 'string' ? data.user.user_metadata.gender : undefined,
        phone: typeof data.user.user_metadata?.phone === 'string' ? data.user.user_metadata.phone : undefined,
        city: typeof data.user.user_metadata?.city === 'string' ? data.user.user_metadata.city : undefined,
      },
    });

    const postAuth = await resolvePostAuthPath({
      userId: data.user.id,
      authEmail: data.user.email ?? normalized,
      emailConfirmed: isEmailConfirmed(data.user),
      nextPath: input.next_path,
      wizardPath: input.wizard_path,
    });

    if (!ensuredProfile.success) {
      return {
        success: true,
        user_id: data.user.id,
        email: data.user.email ?? normalized,
        profile_warning: 'Sua conta foi criada, mas precisamos concluir seus dados.',
        first_access_required: true,
        redirect_to: firstAccessRouteWithNext(postAuth.destination),
        profile_creation_failed: true,
      };
    }

    return {
      success: true,
      user_id: data.user.id,
      email: data.user.email ?? normalized,
      profile_warning: ensuredProfile.warning ?? null,
      first_access_required: postAuth.firstAccessRequired,
      redirect_to: postAuth.redirectTo,
    };
  } catch {
    return { success: false, code: 'connection', message: 'Erro de conexão.' };
  }
}

export async function signUpPublicAccountAction(input: {
  full_name?: string;
  cpf?: string;
  birth_date?: string;
  gender?: string;
  phone?: string;
  email: string;
  city?: string;
  password: string;
  confirmPassword: string;
  acceptPrivacy?: boolean;
  require_profile_fields?: boolean;
  next_path?: string | null;
  wizard_path?: string | null;
}): Promise<SignupActionResult> {
  const supabase = await createServerSupabaseClient();
  const normalized = normalizeEmail(input.email);
  if (!normalized) return { success: false, message: 'E-mail obrigatório.' };
  if (!input.password || input.password.length < 8) {
    return { success: false, message: 'A senha deve ter pelo menos 8 caracteres.' };
  }
  if (input.password !== input.confirmPassword) {
    return { success: false, message: 'A confirmação de senha não confere.' };
  }
  if (input.acceptPrivacy === false) {
    return { success: false, message: 'Você precisa aceitar a política de privacidade.' };
  }

  const requireProfileFields = Boolean(input.require_profile_fields);
  const fullName = input.full_name?.trim() || '';
  const cpfDigits = input.cpf ? removeCpfMask(input.cpf) : '';
  const gender = input.gender?.trim() || '';
  const phoneDigits = input.phone ? input.phone.replace(/\D/g, '') : '';
  const city = input.city?.trim() || '';

  if (requireProfileFields) {
    if (!fullName) return { success: false, message: 'Nome completo é obrigatório.' };
    if (!cpfDigits || !isValidCpf(cpfDigits)) return { success: false, message: 'CPF inválido.' };
    if (!input.birth_date) return { success: false, message: 'Data de nascimento é obrigatória.' };
    if (!gender) return { success: false, message: 'Gênero é obrigatório.' };
    if (!phoneDigits) return { success: false, message: 'Telefone é obrigatório.' };
    if (!city) return { success: false, message: 'Cidade é obrigatória.' };
  }

  const birthDateIso = input.birth_date ? toISODateFromBR(input.birth_date) : null;
  if (input.birth_date && !birthDateIso) {
    return { success: false, message: 'Informe uma data válida no formato dd/MM/aaaa.' };
  }

  if (cpfDigits && isValidCpf(cpfDigits)) {
    // Checa ANTES de criar a conta em auth.users: se o CPF ja pertence a
    // outra conta, bloqueia aqui e NUNCA chama auth.signUp. Fail-closed: se
    // a propria checagem falhar (RPC indisponivel, erro de rede, etc.), NAO
    // seguimos como se estivesse tudo certo -- um erro de leitura nao pode
    // virar permissao silenciosa pra criar conta com CPF duplicado (foi
    // exatamente esse "fail open" que deixou passar o bug real de producao:
    // a RPC estava com um erro de SQL sempre presente e o `if (!conflictError)`
    // fazia a checagem inteira ser pulada, nunca bloqueando nada).
    const { data: conflictData, error: conflictError } = await supabase.rpc('find_conflicting_registration_contact', {
      p_cpf: cpfDigits,
    });
    if (conflictError) {
      console.error('[signUpPublicAccountAction] find_conflicting_registration_contact falhou', {
        message: conflictError.message,
        code: conflictError.code ?? null,
      });
      return {
        success: false,
        message: 'Não foi possível validar seu CPF agora. Tente novamente em instantes.',
      };
    }
    const conflict = Array.isArray(conflictData) ? conflictData[0] : conflictData;
    if (conflict?.has_conflict) {
      return {
        success: false,
        code: 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        message: 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.',
      };
    }
  }

  // Vai pro /auth/callback (mesmo mecanismo usado por convite e por
  // recuperacao de senha), nao direto pra raiz -- garante uma sessao real
  // via cookies do servidor antes de cair em /primeiro-acesso, em vez de
  // depender de deteccao implicita de sessao no client da home.
  const postSignupDestination = resolvePostAuthDestination({
    nextPath: input.next_path,
    wizardPath: input.wizard_path,
    fallback: '/minha-conta',
  });
  const emailRedirectTo = `${appBaseUrl()}/auth/callback?next=${encodeURIComponent(firstAccessRouteWithNext(postSignupDestination))}`;
  const { data, error } = await supabase.auth.signUp({
    email: normalized,
    password: input.password,
    options: {
      emailRedirectTo,
      data: {
        full_name: fullName || normalized.split('@')[0] || 'Participante',
        cpf: cpfDigits || null,
        birth_date: birthDateIso,
        gender: gender || null,
        phone: phoneDigits || null,
        city: city || null,
      },
    },
  });

  if (error || !data.user) {
    const errorMessage = translateAuthErrorMessage(error?.message ?? 'Não foi possível criar a conta.');
    return { success: false, code: translateSignupCode(error?.message ?? ''), message: errorMessage };
  }

  const emailConfirmationRequired = !data.session;
  let profileWarning: string | undefined;
  let profileCreationFailed = false;
  let firstAccessRequired = false;
  let redirectTo: string | undefined;

  if (data.session) {
    const ensuredProfile = await ensureCustomerProfileForSignedUser({
      supabase,
      userId: data.user.id,
      email: data.user.email ?? normalized,
      fallback: {
        full_name: fullName || normalized.split('@')[0] || 'Participante',
        cpf: cpfDigits || undefined,
        birth_date: birthDateIso || undefined,
        gender: gender || undefined,
        phone: phoneDigits || undefined,
        city: city || undefined,
      },
    });

    if (!ensuredProfile.success) {
      profileCreationFailed = true;
      profileWarning = 'Sua conta foi criada, mas precisamos concluir seus dados.';
    }

    if (ensuredProfile.success && ensuredProfile.warning) {
      profileWarning = ensuredProfile.warning;
    }

    if (input.acceptPrivacy) {
      const acceptedAt = new Date().toISOString();
      const metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      await supabase.auth.updateUser({
        data: {
          ...metadata,
          privacy_policy_version: 'current',
          privacy_policy_accepted: true,
          privacy_policy_accepted_at: acceptedAt,
        },
      });
    }

    const postAuth = await resolvePostAuthPath({
      userId: data.user.id,
      authEmail: data.user.email ?? normalized,
      emailConfirmed: isEmailConfirmed(data.user),
      nextPath: input.next_path,
      wizardPath: input.wizard_path,
    });

    firstAccessRequired = profileCreationFailed ? true : postAuth.firstAccessRequired;
    redirectTo = profileCreationFailed ? firstAccessRouteWithNext(postAuth.destination) : postAuth.redirectTo;
  }

  if (emailConfirmationRequired) {
    try {
      await emailProvider.sendAccountConfirmation({
        to: normalized,
        confirmationUrl: emailRedirectTo,
      });
    } catch (mailError) {
      console.warn('Falha ao registrar envio de e-mail de confirmação:', mailError);
    }
  }

  return {
    success: true,
    user_id: data.user.id,
    email: data.user.email ?? normalized,
    email_confirmation_required: emailConfirmationRequired,
    authenticated: Boolean(data.session),
    profile_warning: profileWarning,
    first_access_required: firstAccessRequired,
    redirect_to: redirectTo,
    profile_creation_failed: profileCreationFailed,
  };
}

export async function signOutPublicAccountAction() {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signOut();
  if (error) return { success: false, message: error.message };
  return { success: true };
}

export async function requestPasswordResetAction(email: string) {
  const supabase = await createServerSupabaseClient();
  const normalized = normalizeEmail(email);
  if (!normalized) return { success: false, message: 'E-mail obrigatorio.' };

  // Vai pro /auth/callback primeiro (com next=/redefinir-senha), nao direto
  // pra /redefinir-senha -- e o callback quem sabe trocar o code/token_hash
  // do link por uma sessao de verdade (exchangeCodeForSession/verifyOtp);
  // sem isso, /redefinir-senha chamava auth.updateUser sem nenhuma sessao
  // e falhava.
  const recoveryState = createPasswordRecoveryState(normalized);
  const recoveryDestination = `/redefinir-senha?recovery=${encodeURIComponent(recoveryState)}`;
  const resetUrl = `${appBaseUrl()}/auth/callback?next=${encodeURIComponent(recoveryDestination)}`;
  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: resetUrl,
  });

  // Mensagem sempre neutra pro chamador -- nunca revela se o e-mail existe
  // ou nao (enumeracao). So um erro de rate limit de verdade (que ja nao
  // revela nada sobre a conta) e repassado; qualquer outro erro do
  // Supabase fica só no log do servidor.
  if (error) {
    console.warn('[requestPasswordResetAction] resetPasswordForEmail falhou', { message: error.message, code: error.code ?? null });
    if (error.message.toLowerCase().includes('rate limit') || error.message.toLowerCase().includes('security purposes')) {
      return { success: false, message: 'Muitas solicitações em pouco tempo. Aguarde um instante e tente novamente.' };
    }
    return { success: true };
  }

  try {
    await emailProvider.sendPasswordReset({ to: normalized, resetUrl });
  } catch (mailError) {
    console.warn('Falha ao registrar envio de e-mail de reset:', mailError);
  }

  return { success: true };
}

export async function updatePublicPasswordAction(input: { password: string; confirmPassword: string; recoveryState: string }) {
  const supabase = await createServerSupabaseClient();
  if (!input.password || input.password.length < 8) {
    return { success: false, message: 'A senha deve ter pelo menos 8 caracteres.' };
  }
  if (input.password !== input.confirmPassword) {
    return { success: false, message: 'A confirmacao de senha nao confere.' };
  }

  const { data: userData, error: sessionError } = await supabase.auth.getUser();
  if (sessionError || !userData.user) {
    return {
      success: false,
      code: 'RECOVERY_SESSION_REQUIRED',
      message: 'Este link de recuperacao expirou, ja foi utilizado ou nao possui uma sessao valida. Solicite um novo link.',
    };
  }
  if (!verifyPasswordRecoveryState(input.recoveryState, userData.user.email ?? '')) {
    return {
      success: false,
      code: 'INVALID_RECOVERY_STATE',
      message: 'Este link de recuperacao expirou, ja foi utilizado, pertence a outra conta ou e invalido. Solicite um novo link.',
    };
  }

  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) {
    const code = translateAuthErrorCode(error.message);
    return {
      success: false,
      code,
      message: code === 'weak_password'
        ? 'Escolha uma senha mais forte, com pelo menos 8 caracteres e que nao seja facil de adivinhar.'
        : 'Nao foi possivel redefinir a senha. Solicite um novo link e tente novamente.',
    };
  }
  await supabase.auth.signOut();
  return { success: true };
}

function translatePricingPreviewError(error: { message: string; details?: string | null }) {
  let detailCode: string | null = null;
  if (error.details) {
    try {
      const parsed = JSON.parse(error.details) as { code?: string };
      detailCode = parsed?.code ?? null;
    } catch {
      detailCode = null;
    }
  }
  const code = detailCode ?? error.message;

  if (code === 'TICKET_CATEGORY_UNAVAILABLE') {
    return { code, message: 'Os ingressos desta categoria ainda não estão disponíveis para venda.' };
  }
  if (code === 'TICKET_CATEGORY_REQUIRED') {
    return { code, message: 'Selecione uma categoria de ingresso.' };
  }
  return { code, message: error.message };
}

export async function getPublicPricingPreviewAction(payload: {
  event_id: string;
  ticket_category_id: string | null;
  gender: string;
  coupon_code?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_registration_pricing_preview', {
    p_gender: payload.gender,
    p_coupon_code: payload.coupon_code?.trim() ? payload.coupon_code.trim() : null,
    p_event_id: payload.event_id,
    p_ticket_category_id: payload.ticket_category_id || null,
  });

  if (error) {
    // Mensagem/codigo originais do RPC ficam no log do servidor para diagnostico;
    // o chamador decide a mensagem amigavel a partir de `message`, sem inventar preco.
    console.error('[getPublicPricingPreviewAction] RPC get_registration_pricing_preview falhou', {
      event_id: payload.event_id,
      ticket_category_id: payload.ticket_category_id,
      gender: payload.gender,
      coupon_code: payload.coupon_code ?? null,
      code: error.code ?? null,
      message: error.message,
      details: error.details ?? null,
      hint: error.hint ?? null,
    });
    const translated = translatePricingPreviewError(error);
    return { success: false, message: translated.message, code: translated.code };
  }

  const preview = (Array.isArray(data) ? data[0] : data) as PricingPreview | null;
  if (!preview?.batch_id) {
    return { success: false, message: 'Nao foi possivel calcular o preco.', code: null };
  }

  return {
    success: true,
    pricing: {
      batch_id: String(preview.batch_id),
      batch_name: String(preview.batch_name),
      sequence_number: Number(preview.sequence_number ?? 0),
      base_amount: Number(preview.base_amount ?? 0),
      discount_amount: Number(preview.discount_amount ?? 0),
      final_amount: Number(preview.final_amount ?? 0),
      remaining_slots: Number(preview.remaining_slots ?? 0),
      coupon_message: preview.coupon_message ? String(preview.coupon_message) : null,
      coupon_type: preview.coupon_type ? String(preview.coupon_type) : null,
      discount_percent: Number(preview.discount_percent ?? 0),
    },
  };
}

export async function getPublicBuyerTicketHolderStatusAction(eventId: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: true as const, alreadyHoldsActiveTicket: false };
  }

  const { data, error } = await supabase.rpc('get_public_buyer_ticket_holder_status', {
    p_event_id: eventId,
  });

  if (error) {
    console.error('[getPublicBuyerTicketHolderStatusAction] RPC falhou', { event_id: eventId, message: error.message });
    return { success: false as const, message: error.message };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { already_holds_active_ticket?: boolean } | null;
  return { success: true as const, alreadyHoldsActiveTicket: Boolean(row?.already_holds_active_ticket) };
}

export async function checkPublicCpfAction(payload: { event_id: string; cpf: string }) {
  const cpf = removeCpfMask(payload.cpf);

  if (!isValidCpf(cpf)) {
    return { success: false, message: 'CPF invalido.' };
  }

  return { success: true };
}

export async function saveCheckoutBuyerProfileAction(input: {
  full_name?: string;
  cpf?: string;
  birth_date?: string;
  gender?: string;
  phone?: string;
  city?: string;
  accept_privacy?: boolean;
  privacy_policy_version?: string | null;
}) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false as const, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
    p_user_id: user.id,
  });
  if (profileError) {
    return { success: false as const, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const userMetadata = (user.user_metadata as Record<string, unknown> | undefined) ?? null;

  const existingFullName = String(profile?.full_name ?? '').trim();
  const incomingFullName = String(input.full_name ?? '').trim();
  const metadataFullName = String(userMetadata?.full_name ?? userMetadata?.name ?? '').trim();

  const existingCpf = String(profile?.cpf ?? '').replace(/\D/g, '');
  const incomingCpf = String(input.cpf ?? '').replace(/\D/g, '');
  const metadataCpf = String(userMetadata?.cpf ?? '').replace(/\D/g, '');

  const existingBirth = normalizeBirthDateInput(String(profile?.birth_date ?? ''));
  const incomingBirth = normalizeBirthDateInput(String(input.birth_date ?? ''));
  const metadataBirth = normalizeBirthDateInput(String(userMetadata?.birth_date ?? ''));

  const existingGender = String(profile?.gender ?? '').trim();
  const incomingGender = String(input.gender ?? '').trim();
  const metadataGender = String(userMetadata?.gender ?? '').trim();

  const existingPhone = String(profile?.phone ?? '').replace(/\D/g, '');
  const incomingPhone = String(input.phone ?? '').replace(/\D/g, '');
  const metadataPhone = String(userMetadata?.phone ?? '').replace(/\D/g, '');

  const existingCity = String(profile?.city ?? '').trim();
  const incomingCity = String(input.city ?? '').trim();
  const metadataCity = String(userMetadata?.city ?? '').trim();

  const email = normalizeEmail(user.email ?? '');
  if (!email) {
    return { success: false as const, message: 'Conta sem e-mail válido.' };
  }

  const fullName = existingFullName || incomingFullName || metadataFullName;
  const cpf = existingCpf || incomingCpf || metadataCpf;
  const birthDate = existingBirth || incomingBirth || metadataBirth;
  const gender = existingGender || incomingGender || metadataGender;
  const phone = existingPhone || incomingPhone || metadataPhone;
  const city = existingCity || incomingCity || metadataCity;

  if (cpf && !isValidCpf(cpf)) {
    return { success: false as const, message: 'CPF inválido.' };
  }
  if (birthDate) {
    const birthDateBR = isoToDateBR(birthDate);
    if (!birthDateBR) {
      return { success: false as const, message: 'Informe uma data válida no formato dd/MM/aaaa.' };
    }
  }

  try {
    await upsertCustomerProfileForUser({
      supabase,
      userId: user.id,
      fullName: fullName || 'Participante',
      cpf: cpf || null,
      birthDate: birthDate || null,
      gender: gender || null,
      phone: phone || null,
      email,
      city: city || null,
      loyaltyTierId: profile?.loyalty_tier_id ? String(profile.loyalty_tier_id) : null,
    });
  } catch (error) {
    return {
      success: false as const,
      message: error instanceof Error ? error.message : 'Nao foi possivel atualizar o perfil do comprador.',
    };
  }

  const currentPrivacyAccepted = typeof userMetadata?.privacy_policy_accepted_at === 'string'
    || userMetadata?.privacy_policy_accepted === true;
  const shouldAcceptPrivacy = currentPrivacyAccepted || Boolean(input.accept_privacy);
  if (shouldAcceptPrivacy && !currentPrivacyAccepted) {
    const nowIso = new Date().toISOString();
    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
    await supabase.auth.updateUser({
      data: {
        ...metadata,
        privacy_policy_version: input.privacy_policy_version ?? 'current',
        privacy_policy_accepted: true,
        privacy_policy_accepted_at: nowIso,
      },
    });
  }

  const missingFields = [
    !fullName ? 'full_name' : null,
    !cpf ? 'cpf' : null,
    !birthDate ? 'birth_date' : null,
    !gender ? 'gender' : null,
    phone.length < 10 ? 'phone' : null,
    !city ? 'city' : null,
    !shouldAcceptPrivacy ? 'privacy_policy' : null,
  ].filter(Boolean) as string[];

  return {
    success: true as const,
    profile: {
      full_name: fullName,
      cpf,
      birth_date: birthDate,
      gender,
      phone,
      email,
      city,
      privacy_policy_accepted: shouldAcceptPrivacy,
      missing_fields: missingFields,
    },
  };
}

export async function createPublicRegistrationAction(input: RegistrationCreateInput) {
  const supabase = await createServerSupabaseClient();
  const normalizedPaymentMethod = normalizeCheckoutPaymentMethod(input.payment_method);
  if (!normalizedPaymentMethod) {
    return { success: false, message: 'Forma de pagamento invalida.' };
  }

  const paymentConfig = await getEventPaymentMethodsConfig(supabase, String(input.event_id));
  if (!paymentConfig.success) {
    return { success: false, message: paymentConfig.message };
  }
  if (!isMethodAllowedByConfig(normalizedPaymentMethod, paymentConfig.config)) {
    return { success: false, message: 'A forma de pagamento selecionada nao esta habilitada para este evento.' };
  }

  console.log('[wizard-diagnostic:create]', {
    event_id: input.event_id,
    ticket_category_id: input.ticket_category_id,
    shirtType: input.shirt_type ?? null,
    shirtSize: input.shirt_size ?? null,
    payment_method: normalizedPaymentMethod,
  });
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) return { success: false, message: 'E-mail obrigatorio.' };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const userId = user?.id ?? null;
  if (!userId) {
    return { success: false, message: 'Entre na sua conta para continuar a inscricao.' };
  }

  const cpf = removeCpfMask(input.cpf);
  const birthDateIso = toISODateFromBR(input.birth_date);
  if (!isValidCpf(cpf)) return { success: false, message: 'CPF invalido.' };
  if (!birthDateIso) return { success: false, message: 'Informe uma data válida no formato dd/MM/aaaa.' };

  const { minAge, eventStartsAt } = await getEventMinAgeRule(supabase, String(input.event_id));
  const minAgeSatisfied = isMinimumAgeSatisfied(birthDateIso, eventStartsAt, minAge);
  if (minAgeSatisfied !== true) {
    return { success: false, message: buildMinAgeMessage(minAge, birthDateIso, eventStartsAt) };
  }

  const { data: existingParticipant, error: existingParticipantError } = await supabase
    .from('participants')
    .select('id, user_id, email')
    .eq('event_id', input.event_id)
    .eq('cpf', cpf)
    .maybeSingle();

  if (existingParticipantError) {
    return { success: false, message: existingParticipantError.message };
  }

  if (existingParticipant?.id) {
    const participantUserId = existingParticipant.user_id ? String(existingParticipant.user_id) : null;
    if (participantUserId && participantUserId !== userId) {
      return { success: false, message: 'Este CPF esta vinculado a outra conta para este evento.' };
    }

    if (!participantUserId) {
      const { error: linkExistingError } = await supabase.rpc('link_participant_account_projection', {
        p_participant_id: String(existingParticipant.id),
      });
      if (linkExistingError) {
        return { success: false, message: linkExistingError.message };
      }
    }
  }

  const { data: profileData } = await supabase.rpc('get_customer_profile', {
    p_user_id: userId,
  });
  const currentProfile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;

  const mergedFullName = String(currentProfile?.full_name ?? '').trim() || input.full_name.trim() || String(user?.user_metadata?.full_name ?? '').trim() || 'Participante';
  const mergedCpf = String(currentProfile?.cpf ?? '').replace(/\D/g, '') || cpf;
  const mergedBirthDate = normalizeBirthDateInput(String(currentProfile?.birth_date ?? '')) || birthDateIso;
  const mergedGender = String(currentProfile?.gender ?? '').trim() || input.gender || null;
  const mergedPhone = String(currentProfile?.phone ?? '').replace(/\D/g, '') || input.phone.replace(/\D/g, '');
  const mergedCity = String(currentProfile?.city ?? '').trim() || input.city?.trim() || null;
  const mergedEmail = normalizeEmail(user?.email ?? input.email);

  const { error: profileError } = await upsertCustomerProfileCompat(supabase, {
    userId,
    fullName: mergedFullName,
    cpf: mergedCpf,
    birthDate: mergedBirthDate,
    gender: mergedGender,
    phone: mergedPhone,
    email: mergedEmail,
    city: mergedCity,
    loyaltyTierId: null,
    loyaltyOverride: false,
    loyaltyOverrideReason: null,
    showInParticipantList: true,
    allowFriendRequests: true,
    profileVisibility: 'participants',
  });
  if (profileError) return { success: false, message: profileError.message };

  const { data, error } = await supabase.rpc('create_registration', {
    p_full_name: mergedFullName,
    p_cpf: cpf,
    p_birth_date: birthDateIso,
    p_gender: mergedGender,
    p_phone: mergedPhone,
    p_email: mergedEmail,
    p_city: mergedCity,
    p_shirt_type: input.shirt_type?.trim() || null,
    p_shirt_size: input.shirt_size?.trim() || null,
    p_registration_status: 'pending',
    p_notes: buildRequestScopedNotes(input.notes, input.client_request_id),
    p_payment_method: toDbPaymentMethod(normalizedPaymentMethod),
    p_payment_status: 'pending',
    p_event_id: input.event_id,
    p_coupon_code: input.coupon_code?.trim() || null,
    p_ticket_category_id: input.ticket_category_id,
  });

  if (error) {
    return { success: false, message: translateRegistrationErrorMessage(error.message) };
  }

  const created = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!created?.participant_id) {
    return { success: false, message: 'Nao foi possivel criar a inscricao.' };
  }

  const participantId = String(created.participant_id);

  console.info('[checkout] reservation_created', {
    userId,
    participantId,
    eventId: input.event_id,
    ticketCategoryId: input.ticket_category_id,
    requestId: input.client_request_id ?? null,
  });

  const { error: participantLinkError } = await supabase.rpc('link_participant_account_projection', {
    p_participant_id: participantId,
  });
  if (participantLinkError) return { success: false, message: participantLinkError.message };
  const contactUpdate = await supabase.rpc('update_registration_contact_from_participant', {
    p_participant_id: participantId,
    p_values: { email: normalizedEmail },
  });
  if (contactUpdate.error) return { success: false, message: contactUpdate.error.message };

  const state = await getRegistrationSnapshotByParticipantId(supabase, participantId, input.event_id);
  if (!state.success) return state;

  console.info('[checkout] payment_created', {
    participantId,
    paymentId: state.snapshot.payment_id,
    paymentStatus: state.snapshot.payment_status,
    finalAmount: state.snapshot.final_amount,
  });

  const isCourtesyOrZero = Number(state.snapshot.final_amount ?? 0) <= 0 || String(state.snapshot.payment_status ?? 'pending') === 'paid';
  const orderResult = await syncOrderAndTicket({
    participantId,
    userId,
    shouldIssueTicket: isCourtesyOrZero,
  });
  if (!orderResult.success) {
    return { success: false, message: orderResult.message };
  }

  const refreshedState = await getRegistrationSnapshotByParticipantId(supabase, participantId, input.event_id);
  if (!refreshedState.success) return refreshedState;

  console.info('[checkout] order_created', {
    participantId,
    orderId: refreshedState.snapshot.order_id,
    orderNumber: refreshedState.snapshot.order_number,
    orderStatus: refreshedState.snapshot.payment_status === 'paid' ? 'confirmed' : 'pending',
  });

  if (refreshedState.snapshot.qr_token) {
    console.info('[checkout] ticket_issued', {
      participantId,
      orderId: refreshedState.snapshot.order_id,
      qrToken: refreshedState.snapshot.qr_token,
    });
    console.info('[checkout] qr_issued', {
      participantId,
      orderId: refreshedState.snapshot.order_id,
      qrToken: refreshedState.snapshot.qr_token,
    });
  }

  try {
    await sendTransactionEmails({
      participantId,
      paymentStatus: String(refreshedState.snapshot.payment_status ?? 'pending'),
      paymentMethod: refreshedState.snapshot.payment.payment_method ? String(refreshedState.snapshot.payment.payment_method) : null,
      finalAmount: Number(refreshedState.snapshot.final_amount ?? 0),
      email: normalizedEmail,
      fullName: input.full_name,
    });
  } catch (mailError) {
    console.warn('Falha ao enviar e-mail transacional:', mailError);
  }

  const zeroPaymentReason = describeZeroPaymentReason({
    baseAmount: Number(refreshedState.snapshot.payment.amount ?? 0),
    discountAmount: Number(refreshedState.snapshot.payment.discount_amount ?? 0),
    finalAmount: Number(refreshedState.snapshot.final_amount ?? 0),
    paymentMethod: refreshedState.snapshot.payment.payment_method,
    couponApplied: Boolean(input.coupon_code?.trim()),
  });

  return {
    success: true,
    courtesy_message: zeroPaymentReason?.message ?? null,
    registration: refreshedState.snapshot,
  };
}

export async function createPublicMultiOrderAction(input: MultiOrderCreateInput) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const userId = user?.id ?? null;
  if (!userId) {
    return { success: false as const, message: 'Entre na sua conta para continuar a inscricao.' };
  }
  if (!isEmailConfirmed(user)) {
    return { success: false as const, message: ACCOUNT_NOT_CONFIRMED_MESSAGE, code: 'email_not_confirmed' };
  }

  const normalizedPaymentMethod = normalizeCheckoutPaymentMethod(input.payment_method);
  if (!normalizedPaymentMethod) {
    return { success: false as const, message: 'Forma de pagamento invalida.' };
  }

  const paymentConfig = await getEventPaymentMethodsConfig(supabase, String(input.event_id));
  if (!paymentConfig.success) {
    return { success: false as const, message: paymentConfig.message };
  }
  if (!isMethodAllowedByConfig(normalizedPaymentMethod, paymentConfig.config)) {
    return { success: false as const, message: 'A forma de pagamento selecionada nao esta habilitada para este evento.' };
  }

  const normalizedEmail = normalizeEmail(user?.email ?? input.buyer.email);
  const cpf = removeCpfMask(input.buyer.cpf);
  const birthDateIso = toISODateFromBR(input.buyer.birth_date);

  if (!isValidCpf(cpf)) return { success: false as const, message: 'CPF invalido.' };
  if (!birthDateIso) return { success: false as const, message: 'Informe uma data válida no formato dd/MM/aaaa.' };

  const { minAge, eventStartsAt } = await getEventMinAgeRule(supabase, String(input.event_id));
  const minAgeSatisfied = isMinimumAgeSatisfied(birthDateIso, eventStartsAt, minAge);
  if (minAgeSatisfied !== true) {
    return { success: false as const, message: buildMinAgeMessage(minAge, birthDateIso, eventStartsAt) };
  }

  const quantity = Math.max(1, Math.min(10, Number(input.quantity || 1)));
  const rpcItemsBase = normalizeMultiOrderItemsForRpc(input.items);
  let rpcItems = rpcItemsBase.map((item) => ({
    ...item,
    pricing_gender: resolvePricingGender({
      itemGender: item.pricing_gender,
      requestGender: input.gender,
      buyerGender: input.buyer.gender,
    }),
  }));

  const invalidPricingItemIndex = rpcItems.findIndex((item) => item.pricing_gender !== 'male' && item.pricing_gender !== 'female');
  if (invalidPricingItemIndex >= 0) {
    return {
      success: false as const,
      message: `Genero/preco invalido no ingresso ${invalidPricingItemIndex + 1}. Selecione Masculino ou Feminino.`,
    };
  }

  const firstItem = rpcItems[0];
  const fallbackGender = resolvePricingGender({
    itemGender: firstItem?.pricing_gender,
    requestGender: input.gender,
    buyerGender: input.buyer.gender,
  });
  if (!fallbackGender) {
    return {
      success: false as const,
      message: 'Genero/preco invalido para o primeiro ingresso. Selecione Masculino ou Feminino.',
    };
  }
  const buyerFullName = toRequiredTextParam(input.buyer.full_name, 'Participante');
  const buyerGender = toRequiredTextParam(input.buyer.gender, fallbackGender);
  const buyerPhone = toRequiredTextParam(input.buyer.phone, '');
  const buyerCity = toRequiredTextParam(input.buyer.city, '');
  const couponCode = toTextParam(input.coupon_code);
  const defaultShirtType = toTextParam(input.shirt_type);
  const defaultShirtSize = toTextParam(input.shirt_size);
  const requestId = toTextParam(input.client_request_id);
  const notes = buildRequestScopedNotes(toTextParam(input.notes) ?? undefined, requestId ?? undefined);

  const firstOwnershipMode = rpcItems[0]?.ownership_mode;
  const isExplicitlyForSomeoneElse = firstOwnershipMode === 'named' || firstOwnershipMode === 'unassigned';
  const assignmentRequested = input.assign_first_to_buyer !== false && !isExplicitlyForSomeoneElse;
  let effectiveAssignFirstToBuyer = assignmentRequested;

  if (assignmentRequested) {
    const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
      p_user_id: userId,
    });
    if (profileError) {
      return { success: false as const, message: 'Não foi possível validar o perfil do comprador.' };
    }

    const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
    const profileCpf = removeCpfMask(String(profile?.cpf ?? ''));
    const profileGender = normalizePricingGenderInput(String(profile?.gender ?? ''));
    const profileIsValid = Boolean(
      String(profile?.full_name ?? '').trim()
      && isValidCpf(profileCpf)
      && String(profile?.birth_date ?? '').trim()
      && profileGender
      && String(profile?.phone ?? '').replace(/\D/g, '').length >= 10,
    );

    if (!profileIsValid || profileCpf !== cpf) {
      return {
        success: false as const,
        message: 'Complete e valide os dados da sua conta antes de definir automaticamente o titular.',
      };
    }

    const itemPricingGender = rpcItems[0]?.pricing_gender;
    if (!itemPricingGender || itemPricingGender !== profileGender) {
      return {
        success: false as const,
        message: 'VALIDACAO_ADMINISTRATIVA: gênero do titular incompatível ou ambíguo para o preço selecionado.',
      };
    }

    const { data: accountParticipants, error: accountParticipantsError } = await supabase
      .from('participants')
      .select('id, cpf, registration_contact_id')
      .eq('event_id', String(input.event_id))
      .eq('user_id', userId)
      .limit(3);

    if (accountParticipantsError) {
      return { success: false as const, message: 'Não foi possível validar a titularidade neste evento.' };
    }
    if ((accountParticipants ?? []).length > 1) {
      return {
        success: false as const,
        message: 'VALIDACAO_ADMINISTRATIVA: usuário possui múltiplos cadastros de participante neste evento.',
      };
    }

    const existingAccountParticipant = accountParticipants?.[0];
    let existingContactId = String(existingAccountParticipant?.registration_contact_id ?? '');
    if (existingAccountParticipant && removeCpfMask(String(existingAccountParticipant.cpf ?? '')) !== cpf) {
      return {
        success: false as const,
        message: 'VALIDACAO_ADMINISTRATIVA: cadastro existente do usuário possui CPF divergente neste evento.',
      };
    }

    if (!existingAccountParticipant) {
      const { data: unlinkedParticipantsForEvent, error: unlinkedParticipantsError } = await supabase
        .from('participants')
        .select('id, cpf, registration_contact_id')
        .eq('event_id', String(input.event_id))
        .is('user_id', null);

      if (unlinkedParticipantsError) {
        return { success: false as const, message: 'Não foi possível validar cadastros anteriores neste evento.' };
      }
      const matchingUnlinkedParticipants = (unlinkedParticipantsForEvent ?? [])
        .filter((participant) => removeCpfMask(String(participant.cpf ?? '')) === cpf);
      if (matchingUnlinkedParticipants.length > 1) {
        return {
          success: false as const,
          message: 'VALIDACAO_ADMINISTRATIVA: existem múltiplos cadastros sem conta para este CPF no evento.',
        };
      }
      existingContactId = String(matchingUnlinkedParticipants[0]?.registration_contact_id ?? '');
    }

    const contactId = existingContactId;
    if (contactId) {
      try {
        const holderState = await registrationContactHasActiveTicket(supabase, String(input.event_id), contactId);
        effectiveAssignFirstToBuyer = shouldAssignBuyerToNewOrder(assignmentRequested, holderState.hasActiveTicket);
      } catch (holderLookupError) {
        effectiveAssignFirstToBuyer = false;
        console.warn('[checkout:create-order] holder lookup failed; disabling auto assignment', {
          event_id: input.event_id,
          registration_contact_id: contactId,
          error: holderLookupError instanceof Error ? holderLookupError.message : String(holderLookupError),
        });
      }
    }

    const ownershipModes=buyerOwnershipModes(quantity,assignmentRequested,!effectiveAssignFirstToBuyer);
    rpcItems = rpcItems.map((item,index) => ownershipModes[index]==='self' ? {
      ...item, ownership_mode: 'self', ownership_status: 'assigned',
      holder_full_name: null, holder_registration_contact_id: null, holder_cpf: null, holder_email: null, holder_phone: null,
    } : item.ownership_mode === 'named' ? {
      ...item, ownership_mode: 'named', ownership_status: 'unassigned',
    } : {
      ...item, ownership_mode: 'unassigned', ownership_status: 'unassigned',
      holder_full_name: null, holder_registration_contact_id: null, holder_cpf: null, holder_email: null, holder_phone: null,
    });
  }

  const createOrderRpcPayload = {
    p_event_id: String(input.event_id),
    p_ticket_category_id: input.ticket_category_id ? String(input.ticket_category_id) : null,
    p_gender: fallbackGender,
    p_quantity: quantity,
    p_payment_method: toDbPaymentMethod(normalizedPaymentMethod),
    p_coupon_code: couponCode,
    p_shirt_type: firstItem?.shirt_type ?? defaultShirtType,
    p_shirt_size: firstItem?.shirt_size ?? defaultShirtSize,
    p_buyer_full_name: buyerFullName,
    p_buyer_cpf: cpf,
    p_buyer_birth_date: birthDateIso,
    p_buyer_gender: buyerGender,
    p_buyer_phone: buyerPhone,
    p_buyer_email: String(normalizedEmail),
    p_buyer_city: buyerCity,
    p_assign_first_to_buyer: effectiveAssignFirstToBuyer,
    p_items: rpcItems,
    p_limit_per_order: 10,
    p_notes: notes,
    p_client_request_id: requestId,
  };

  console.info('[checkout:create-order] pre-create', {
    participant: {
      full_name: buyerFullName,
      cpf_masked: maskCpfForLog(cpf),
      birth_date: birthDateIso,
      gender: buyerGender,
      phone: buyerPhone,
      email: normalizedEmail,
      city: buyerCity,
    },
    order: {
      event_id: createOrderRpcPayload.p_event_id,
      ticket_category_id: createOrderRpcPayload.p_ticket_category_id,
      quantity,
      payment_method: createOrderRpcPayload.p_payment_method,
      payment_method_requested: normalizedPaymentMethod,
      coupon_code: createOrderRpcPayload.p_coupon_code,
      client_request_id: createOrderRpcPayload.p_client_request_id,
      notes: createOrderRpcPayload.p_notes,
    },
    order_items: rpcItems,
    reservations: {
      expected_item_reservations: quantity,
      assign_first_to_buyer: createOrderRpcPayload.p_assign_first_to_buyer,
    },
    inventory_adjustments: summarizeInventoryAdjustments(rpcItems),
    rpc_payload: {
      rpc_name: 'create_multi_ticket_order_checkout',
      payload: createOrderRpcPayload,
    },
  });

  const { data, error } = await supabase.rpc('create_multi_ticket_order_checkout', createOrderRpcPayload);

  if (error) {
    return { success: false as const, message: translateRegistrationErrorMessage(error.message) };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row?.order_id) {
    return { success: false as const, message: 'Nao foi possivel criar o pedido multi-ingressos.' };
  }

  console.info('[checkout:create-order] rpc-success', {
    rpc_name: 'create_multi_ticket_order_checkout',
    order_id: String(row.order_id),
    payment_id: row.payment_id ? String(row.payment_id) : null,
    item_count: Number(row.item_count ?? 0),
  });

  console.info('[checkout:create-order] rpc-payload', {
    rpc_name: 'get_order_checkout_snapshot',
    payload: {
      p_order_id: String(row.order_id),
    },
  });

  const snapshot = await getOrderSnapshotByOrderId(supabase, String(row.order_id));
  if (!snapshot.success) return snapshot;

  return {
    success: true as const,
    order: snapshot.snapshot,
  };
}

export async function generatePublicOrderPixAction(orderId: string) {
  const supabase = await createServerSupabaseClient();

  const snapshotResult = await getOrderSnapshotByOrderId(supabase, orderId);
  if (!snapshotResult.success) return snapshotResult;

  const payment = snapshotResult.snapshot.payment;
  if (payment.payment_status === 'paid') {
    return { success: true as const, payment };
  }

  if (payment.final_amount <= 0) {
    return { success: false as const, message: 'Pagamento nao necessario para este pedido.' };
  }

  if (payment.expires_at && payment.payment_method === 'pix') {
    if (payment.pix_code) {
      return {
        success: true as const,
        payment,
      };
    }
  }

  const gateway = getPaymentGatewayProvider();

  const { data: payerRows, error: payerError } = await supabase.rpc('get_order_payer_details', { p_order_id: orderId });
  if (payerError) return { success: false as const, message: payerError.message };
  const payerRow = (Array.isArray(payerRows) ? payerRows[0] : payerRows) as Record<string, unknown> | null;
  if (!payerRow?.payment_id) return { success: false as const, message: 'Pagamento nao encontrado para o pedido.' };

  const payerFullName = payerRow.payer_full_name ? String(payerRow.payer_full_name) : '';
  const payerEmail = payerRow.payer_email ? String(payerRow.payer_email) : '';
  const payerCpf = payerRow.payer_cpf ? String(payerRow.payer_cpf) : '';

  if (gateway.name === 'asaas' && (!payerFullName || !payerEmail || !payerCpf)) {
    return {
      success: false as const,
      message: 'Complete seu nome, e-mail e CPF em Meus dados antes de gerar o PIX.',
    };
  }

  let payload;
  try {
    payload = await gateway.createPixPayment({
      organizationId: String(payerRow.organization_id ?? ''),
      orderId,
      paymentId: String(payerRow.payment_id),
      amount: payment.final_amount,
      dueDate: todayAsPixDueDate(),
      payer: {
        name: payerFullName,
        email: payerEmail,
        cpfCnpj: payerCpf,
        phone: payerRow.payer_phone ? String(payerRow.payer_phone) : undefined,
      },
      description: snapshotResult.snapshot.order_number ? `Pedido ${snapshotResult.snapshot.order_number}` : undefined,
    });
  } catch (gatewayError) {
    console.error('[checkout:pix] gateway_create_pix_failed', {
      order_id: orderId,
      provider: gateway.name,
      error: gatewayError instanceof Error ? gatewayError.message : String(gatewayError),
    });
    return { success: false as const, message: 'Nao foi possivel gerar o PIX agora. Tente novamente em instantes.' };
  }

  const { data, error } = await supabase.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: payload.pixCode,
    p_pix_qrcode: payload.pixQrCodeImage,
    p_gateway_payment_id: payload.providerPaymentId,
    p_expires_at: payload.expiresAt,
    p_provider: gateway.name,
  });

  if (error) return { success: false as const, message: error.message };

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return { success: false as const, message: 'Falha ao gerar PIX.' };

  return {
    success: true as const,
    payment: mapOrderPayment(row),
  };
}

/**
 * "Simular pagamento aprovado" -- disponivel SOMENTE quando o provider
 * efetivo for 'fake'. A checagem aqui e so uma conveniencia de UX (falha
 * cedo, sem round-trip); a validacao que realmente importa e a da RPC
 * simulate_fake_gateway_payment_paid (SECURITY DEFINER, confere contra
 * payments.provider gravado no banco -- nunca confia em NODE_ENV nem em
 * nada vindo do cliente). Reusa 100% o caminho canonico de confirmacao de
 * pagamento (apply_gateway_payment_status -> confirm_order_payment_and_issue_tickets),
 * o mesmo que um webhook real da Asaas percorreria -- nenhuma emissao de
 * ticket paralela.
 */
export async function simulateFakeOrderPaymentAction(orderId: string) {
  if (getPaymentGatewayProviderName() !== 'fake') {
    return { success: false as const, message: 'Simulacao de pagamento so esta disponivel quando o provider de pagamento e fake.' };
  }

  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });

  if (error) return { success: false as const, message: translateRegistrationErrorMessage(error.message) };

  const snapshot = await getUnifiedOrderSnapshot(supabase, orderId);
  if (!snapshot.success) return snapshot;

  return {
    success: true as const,
    order: snapshot.snapshot,
  };
}

export async function generatePublicPixAction(participantId: string) {
  const supabase = await createServerSupabaseClient();

  const { data: detailsData, error: detailsError } = await supabase.rpc('get_participant_payment_details', {
    p_participant_id: participantId,
  });

  if (detailsError) return { success: false, message: detailsError.message };

  const details = (Array.isArray(detailsData) ? detailsData[0] : detailsData) as Record<string, unknown> | null;
  if (!details) return { success: false, message: 'Pagamento nao encontrado.' };
  if (Number(details.final_amount ?? 0) <= 0) {
    return { success: false, message: 'Pagamento nao necessario para esta inscricao.' };
  }
  if (String(details.payment_status ?? 'pending') === 'paid') {
    return { success: true, payment: mapPayment(details) };
  }
  if (String(details.pix_code ?? '').trim()) {
    return { success: true, payment: mapPayment(details) };
  }

  const payload = await paymentProvider.createPix({
    participantId,
    amount: Number(details.final_amount ?? 0),
    expiresInMinutes: 120,
  });

  const { data, error } = await supabase.rpc('start_payment_pix', {
    p_participant_id: participantId,
    p_pix_code: payload.pixCode,
    p_pix_qrcode: payload.pixQrCode,
    p_gateway_payment_id: payload.gatewayPaymentId,
    p_expires_at: payload.expiresAt,
  });

  if (error) return { success: false, message: error.message };

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return { success: false, message: 'Falha ao gerar PIX.' };

  return { success: true, payment: mapPayment(row) };
}

export async function simulatePublicPaymentAction(participantId: string, method: 'pix' | 'credit_card') {
  if (process.env.NODE_ENV !== 'development') {
    return { success: false, message: 'A confirmacao simulada esta disponivel apenas em desenvolvimento.' };
  }

  const supabase = await createServerSupabaseClient();

  const { data: currentData, error: currentError } = await supabase.rpc('get_participant_payment_details', {
    p_participant_id: participantId,
  });
  if (currentError) return { success: false, message: currentError.message };
  const current = (Array.isArray(currentData) ? currentData[0] : currentData) as Record<string, unknown> | null;
  if (!current) return { success: false, message: 'Pagamento nao encontrado.' };

  if (String(current.payment_status ?? 'pending') === 'paid') {
    const { data: ticket } = await supabase.from('tickets').select('token, status').eq('participant_id', participantId).maybeSingle();
    const { data: order } = await supabase.from('orders').select('id, order_number, status').eq('participant_id', participantId).maybeSingle();
    console.info('[checkout] duplicate_payment_blocked', { participantId, orderId: order?.id ?? null });
    return {
      success: true,
      payment: mapPayment(current),
      order_id: order?.id ? String(order.id) : null,
      order_number: order?.order_number ? String(order.order_number) : null,
      order_status: order?.status ? String(order.status) : null,
      qr_token: ticket?.token ? String(ticket.token) : null,
      ticket_status: ticket?.status ? String(ticket.status) : null,
      reservation_status: null,
      reservation_expires_at: null,
    };
  }

  await paymentProvider.confirmPayment({ participantId, method });

  const { error } = await supabase.rpc('simulate_payment_paid', {
    p_participant_id: participantId,
    p_payment_method: method,
  });

  if (error) return { success: false, message: error.message };

  const { data, error: detailsError } = await supabase.rpc('get_participant_payment_details', {
    p_participant_id: participantId,
  });

  if (detailsError) return { success: false, message: detailsError.message };
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) return { success: false, message: 'Pagamento nao encontrado.' };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.id) {
    return { success: false, message: 'Sessao invalida para confirmar o pedido.' };
  }

  const orderResult = await syncOrderAndTicket({
    participantId,
    userId: user.id,
    shouldIssueTicket: true,
  });
  if (!orderResult.success) return { success: false, message: orderResult.message };

  const [{ data: participant }, { data: ticket }, { data: order }] = await Promise.all([
    supabase
      .from('participants')
      .select('email, full_name, reservation_status, reservation_expires_at')
      .eq('id', participantId)
      .maybeSingle(),
    supabase.from('tickets').select('token, status').eq('participant_id', participantId).maybeSingle(),
    supabase.from('orders').select('id, order_number, status').eq('participant_id', participantId).maybeSingle(),
  ]);

  const participantEmail = normalizeEmail(participant?.email ? String(participant.email) : user.email ?? null);
  if (participantEmail) {
    try {
      await sendTransactionEmails({
        participantId,
        paymentStatus: 'paid',
        paymentMethod: method,
        finalAmount: Number(row.final_amount ?? 0),
        email: participantEmail,
        fullName: String(participant?.full_name ?? ''),
      });
    } catch (mailError) {
      console.warn('Falha ao enviar e-mail de ingresso confirmado:', mailError);
    }
  }

  console.info('[checkout] ticket_issued', {
    participantId,
    orderId: order?.id ?? null,
    paymentMethod: method,
    paymentStatus: String(row.payment_status ?? 'paid'),
  });
  if (ticket?.token) {
    console.info('[checkout] qr_issued', {
      participantId,
      orderId: order?.id ?? null,
      qrToken: String(ticket.token),
    });
  }

  return {
    success: true,
    payment: mapPayment(row),
    order_id: order?.id ? String(order.id) : null,
    order_number: order?.order_number ? String(order.order_number) : null,
    order_status: order?.status ? String(order.status) : null,
    qr_token: ticket?.token ? String(ticket.token) : null,
    ticket_status: ticket?.status ? String(ticket.status) : null,
    reservation_status: participant?.reservation_status ? String(participant.reservation_status) : null,
    reservation_expires_at: participant?.reservation_expires_at ? String(participant.reservation_expires_at) : null,
  };
}

export async function getPublicRegistrationSnapshotAction(participantId: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false, message: 'Sessao necessaria para visualizar sua inscricao.' };
  }

  const [{ data: participant, error: participantError }, { data: paymentData, error: paymentError }, { data: ticketRows, error: ticketError }] = await Promise.all([
    supabase
      .from('participants')
      .select('id, event_id, full_name, cpf, registration_status, reservation_status, reservation_expires_at, created_at, shirt_type, shirt_size, ticket_categories(name), registration_batches(name), events(name)')
      .eq('id', participantId)
      .eq('user_id', user.id)
      .single(),
    supabase.rpc('get_participant_payment_details', { p_participant_id: participantId }),
    supabase
      .from('tickets')
      .select('id, token, status, order_items!inner(participant_id)')
      .eq('order_items.participant_id', participantId)
      .neq('status', 'cancelled')
      .limit(2),
  ]);

  if (participantError) return { success: false, message: participantError.message };
  if (paymentError) return { success: false, message: paymentError.message };
  if (ticketError) return { success: false, message: ticketError.message };
  if ((ticketRows?.length ?? 0) > 1) {
    return { success: false, message: 'Mais de um ingresso encontrado para o participante; informe o ingresso explicitamente.' };
  }
  const ticket = ticketRows?.[0] ?? null;
  const { data: ticketKitData, error: ticketKitError } = ticket?.id
    ? await supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticket.id })
    : { data: [] as Array<Record<string, unknown>>, error: null };
  if (ticketKitError) return { success: false, message: ticketKitError.message };

  const paymentRow = (Array.isArray(paymentData) ? paymentData[0] : paymentData) as Record<string, unknown> | null;
  if (!paymentRow) return { success: false, message: 'Pagamento nao encontrado.' };

  const maskedCpf = (() => {
    const cpf = String(participant.cpf ?? '').replace(/\D/g, '').padStart(11, '0');
    return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-XX`;
  })();

  return {
    success: true,
    snapshot: {
      participant_id: String(participant.id),
      event_id: String(participant.event_id),
      event_name: relationName(participant.events) ?? String(paymentRow.event_name ?? ''),
      full_name: String(participant.full_name ?? ''),
      masked_cpf: maskedCpf,
      registration_status: String(participant.registration_status ?? 'pending'),
      reservation_status: String(participant.reservation_status ?? 'pending'),
      reservation_expires_at: participant.reservation_expires_at ? String(participant.reservation_expires_at) : null,
      created_at: participant.created_at ? String(participant.created_at) : null,
      category_name: relationName(participant.ticket_categories),
      batch_name: relationName(participant.registration_batches),
      shirt_type: participant.shirt_type ? String(participant.shirt_type) : null,
      shirt_size: participant.shirt_size ? String(participant.shirt_size) : null,
      payment: mapPayment(paymentRow),
      kit_items: (ticketKitData ?? []).map((item: Record<string, unknown>) => ({
        kit_item_id: String(item.kit_item_id ?? ''),
        item_name: String(item.item_name ?? ''),
        item_type: String(item.item_type ?? ''),
        quantity: Number(item.quantity ?? 1),
        status: String(item.status ?? 'reserved'),
        delivered_at: item.delivered_at ? String(item.delivered_at) : null,
      })),
      qr_token: ticket?.token ? String(ticket.token) : null,
      ticket_status: ticket?.status ? String(ticket.status) : null,
    },
  };
}

// ============================================================
// Carrinho: ingresso + "compre junto" (produtos da loja) no mesmo pedido,
// e cupom com escopo configuravel. O pedido ja existe (criado sem cupom ao
// sair da etapa Dados, via createPublicMultiOrderAction) -- estas actions
// operam sobre esse pedido real, nunca sobre um estado hipotetico.
// ============================================================

function translateCartErrorMessage(error: { message?: string; details?: string | null }) {
  const serialized = `${error.message ?? ''} ${error.details ?? ''}`;
  const knownCodes = ['PRODUCT_OUT_OF_STOCK', 'COUPON_INVALID', 'COUPON_INACTIVE', 'COUPON_NOT_YET_VALID', 'COUPON_EXPIRED', 'COUPON_USES_EXHAUSTED', 'COUPON_NO_ELIGIBLE_ITEMS'];
  const matchedCode = knownCodes.find((code) => serialized.includes(code));
  if (!matchedCode) return error.message ?? 'Nao foi possivel concluir a operacao.';
  try {
    const detail = JSON.parse(error.details ?? '{}') as { message?: string };
    return detail.message ?? error.message ?? 'Nao foi possivel concluir a operacao.';
  } catch {
    return error.message ?? 'Nao foi possivel concluir a operacao.';
  }
}

export async function getEligibleCartProductsAction(eventId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_store_items_for_event', { p_event_id: eventId });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, products: (data ?? []) as Array<Record<string, unknown>> };
}

export async function getCartOrderDetailsAction(orderId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_cart_order_details', { p_order_id: orderId });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return { success: true as const, cart: data as Record<string, unknown> };
}

export async function addProductToCartAction(orderId: string, storeItemId: string, variantId: string | null, quantity: number) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('add_product_to_cart_order', {
    p_order_id: orderId, p_store_item_id: storeItemId, p_variant_id: variantId, p_quantity: quantity,
  });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return getCartOrderDetailsAction(orderId);
}

export async function removeCartOrderItemAction(orderId: string, orderItemId: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('remove_cart_order_item', { p_order_item_id: orderItemId });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return getCartOrderDetailsAction(orderId);
}

export async function setCartOrderItemQuantityAction(orderId: string, orderItemId: string, quantity: number) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('set_cart_order_item_quantity', { p_order_item_id: orderItemId, p_quantity: quantity });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return getCartOrderDetailsAction(orderId);
}

export async function changePendingOrderItemShirtAction(orderId: string, orderItemId: string, shirtType: string, shirtSize: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('change_pending_order_item_shirt', {
    p_order_id: orderId, p_order_item_id: orderItemId, p_shirt_type: shirtType, p_shirt_size: shirtSize,
  });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return getCartOrderDetailsAction(orderId);
}

// Genero de precificacao e independente de shirt_type/shirt_size (RPC
// propria, change_pending_order_item_gender -- migration 20260846000000):
// muda unit_price/discount_amount/final_amount do item e recalcula o
// pedido inteiro via apply_cart_coupon, o que change_pending_order_item_shirt
// nunca faz.
export async function changePendingOrderItemGenderAction(orderId: string, orderItemId: string, gender: 'male' | 'female') {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('change_pending_order_item_gender', {
    p_order_id: orderId, p_order_item_id: orderItemId, p_gender: gender,
  });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  return getCartOrderDetailsAction(orderId);
}

export async function applyCartCouponAction(orderId: string, couponCode: string | null) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: couponCode ?? '' });
  if (error) return { success: false as const, message: translateCartErrorMessage(error) };
  // Best-effort: se o total do carrinho mudou e havia uma cobranca externa
  // (gateway real) associada, apply_cart_coupon ja invalidou o vinculo local
  // -- isso so cancela a cobranca do LADO DO GATEWAY para que pare de ser
  // pagavel com o preco antigo. Nunca bloqueia a resposta ao usuario.
  await cancelPendingExternalCharge(supabase, orderId);
  return getCartOrderDetailsAction(orderId);
}

export async function finalizeCartOrderAction(orderId: string, paymentMethod: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('finalize_cart_order_payment', { p_order_id: orderId, p_payment_method: paymentMethod });
  if (error) return { success: false as const, message: translateRegistrationErrorMessage(error.message) };

  const snapshot = await getUnifiedOrderSnapshot(supabase, orderId);
  if (!snapshot.success) return snapshot;
  return { success: true as const, order: snapshot.snapshot };
}
