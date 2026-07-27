'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { calculateAge, isValidCpf, removeCpfMask } from '@/lib/validation/registration';
import { getPaymentProvider } from '@/lib/payments/get-provider';
import { toISODateFromBR } from '@/lib/utils/date';
import { formatDateBR } from '@/lib/utils/date';
import { getEmailProvider } from '@/lib/email/fake-provider';
import { getFirstAccessFlags } from '@/lib/account/first-access';
import { resolvePostAuthDestination, sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';

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
  payment_method: 'pix' | 'credit_card';
  coupon_code?: string;
  notes?: string;
  client_request_id?: string;
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
  if (normalized.includes('already registered')) return 'already_registered';
  if (normalized.includes('invalid email')) return 'invalid_email';
  if (normalized.includes('email address') && normalized.includes('is invalid')) return 'invalid_email';
  if (normalized.includes('weak password')) return 'weak_password';

  return 'unknown';
}

function appBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

function translateSignupCode(message: string) {
  return translateAuthErrorCode(message);
}

function accountOrdersUrl() {
  return `${appBaseUrl()}/minha-conta/compras`;
}

function firstAccessRouteWithNext(nextPath: string) {
  const safeNext = sanitizePostFirstAccessNextPath(nextPath, '/minha-conta');
  return `/primeiro-acesso?next=${encodeURIComponent(safeNext)}`;
}

async function resolvePostAuthPath(params: {
  userId: string;
  authEmail?: string | null;
  nextPath?: string | null;
  wizardPath?: string | null;
}) {
  const destination = resolvePostAuthDestination({
    nextPath: params.nextPath,
    wizardPath: params.wizardPath,
    fallback: '/minha-conta',
  });

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

  return { success: true as const, warning: null };
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

function translateRegistrationErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('cpf ja cadastrado')) return 'Este CPF ja esta inscrito neste evento.';
  if (normalized.includes('capacidade da categoria')) return 'Categoria esgotada para este evento.';
  if (normalized.includes('estoque indisponivel')) return 'Camiseta sem estoque para o modelo/tamanho selecionado.';
  if (normalized.includes('estoque nao encontrado')) return 'Camiseta indisponivel para o modelo/tamanho selecionado.';
  if (normalized.includes('inscricoes fechadas')) return 'As inscricoes para este evento estao encerradas.';
  if (normalized.includes('lotes esgotados') || normalized.includes('lote')) return 'Lote encerrado ou sem disponibilidade.';
  if (normalized.includes('cupom')) return message;
  return message;
}

async function getRegistrationSnapshotByParticipantId(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  participantId: string,
  fallbackEventId: string,
) {
  const [{ data: paymentData, error: paymentError }, { data: participantData, error: participantError }, { data: kitData, error: kitError }, { data: ticket }, { data: order }] = await Promise.all([
    supabase.rpc('get_participant_payment_details', { p_participant_id: participantId }),
    supabase
      .from('participants')
      .select('id, event_id, full_name, registration_status, reservation_status, reservation_expires_at, shirt_type, shirt_size, email, ticket_categories(name), registration_batches(name)')
      .eq('id', participantId)
      .single(),
    supabase.rpc('get_participant_kit_items', { p_participant_id: participantId }),
    supabase.from('tickets').select('token').eq('participant_id', participantId).maybeSingle(),
    supabase.from('orders').select('id, order_number, status').eq('participant_id', participantId).maybeSingle(),
  ]);

  if (paymentError) return { success: false as const, message: paymentError.message };
  if (participantError) return { success: false as const, message: participantError.message };
  if (kitError) return { success: false as const, message: kitError.message };

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
      kit_items: (kitData ?? []).map((item: Record<string, unknown>) => ({
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
    supabase.rpc('get_participant_kit_items', { p_participant_id: params.participantId }),
  ]);

  if (params.paymentStatus === 'paid' && ticket?.token && order && participant) {
    const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
    await emailProvider.sendTicketConfirmation({
      to: params.email,
      participantName: params.fullName,
      eventName: String(eventObj?.name ?? 'Evento'),
      eventDate: eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null,
      eventLocation: eventObj?.location ? String(eventObj.location) : null,
      categoryName: relationName(participant.ticket_categories),
      kitItems: (kitItems ?? []).map((item: Record<string, unknown>) => ({
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
  if (input.birth_date && calculateAge(input.birth_date) < 18) {
    return { success: false, message: 'A inscrição exige idade mínima de 18 anos.' };
  }

  const emailRedirectTo = `${appBaseUrl()}/`;
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

  const resetUrl = `${appBaseUrl()}/redefinir-senha`;
  const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
    redirectTo: resetUrl,
  });
  if (error) return { success: false, message: error.message };

  try {
    await emailProvider.sendPasswordReset({ to: normalized, resetUrl });
  } catch (mailError) {
    console.warn('Falha ao registrar envio de e-mail de reset:', mailError);
  }

  return { success: true };
}

export async function updatePublicPasswordAction(input: { password: string; confirmPassword: string }) {
  const supabase = await createServerSupabaseClient();
  if (!input.password || input.password.length < 8) {
    return { success: false, message: 'A senha deve ter pelo menos 8 caracteres.' };
  }
  if (input.password !== input.confirmPassword) {
    return { success: false, message: 'A confirmacao de senha nao confere.' };
  }

  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) return { success: false, message: error.message };
  return { success: true };
}

export async function getPublicPricingPreviewAction(payload: {
  event_id: string;
  ticket_category_id: string;
  gender: string;
  coupon_code?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_registration_pricing_preview', {
    p_gender: payload.gender,
    p_coupon_code: payload.coupon_code?.trim() ? payload.coupon_code.trim() : null,
    p_event_id: payload.event_id,
    p_ticket_category_id: payload.ticket_category_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  const preview = (Array.isArray(data) ? data[0] : data) as PricingPreview | null;
  if (!preview?.batch_id) {
    return { success: false, message: 'Nao foi possivel calcular o preco.' };
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

export async function checkPublicCpfAction(payload: { event_id: string; cpf: string }) {
  const supabase = await createServerSupabaseClient();
  const cpf = removeCpfMask(payload.cpf);

  if (!isValidCpf(cpf)) {
    return { success: false, message: 'CPF invalido.' };
  }

  const { data, error } = await supabase
    .from('participants')
    .select('id')
    .eq('event_id', payload.event_id)
    .eq('cpf', cpf)
    .maybeSingle();

  if (error) return { success: false, message: error.message };
  if (data?.id) return { success: false, message: 'Este CPF ja esta inscrito neste evento.' };

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
    if (calculateAge(birthDateBR) < 18) {
      return { success: false as const, message: 'A inscricao exige idade minima de 18 anos.' };
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
  console.log('[wizard-diagnostic:create]', {
    event_id: input.event_id,
    ticket_category_id: input.ticket_category_id,
    shirtType: input.shirt_type ?? null,
    shirtSize: input.shirt_size ?? null,
    payment_method: input.payment_method,
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

  const age = calculateAge(input.birth_date);
  if (age < 18) return { success: false, message: 'A inscricao exige idade minima de 18 anos.' };

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
      return { success: false, message: 'Este CPF ja esta inscrito neste evento.' };
    }

    if (!participantUserId) {
      const { error: linkExistingError } = await supabase
        .from('participants')
        .update({ user_id: userId, email: normalizedEmail })
        .eq('id', String(existingParticipant.id));
      if (linkExistingError) {
        return { success: false, message: linkExistingError.message };
      }
    }

    const reusedParticipantId = String(existingParticipant.id);
    const state = await getRegistrationSnapshotByParticipantId(supabase, reusedParticipantId, input.event_id);
    if (!state.success) return state;

    const isCourtesyOrZero = Number(state.snapshot.final_amount ?? 0) <= 0 || String(state.snapshot.payment_status ?? 'pending') === 'paid';
    const orderResult = await syncOrderAndTicket({
      participantId: reusedParticipantId,
      userId,
      shouldIssueTicket: isCourtesyOrZero,
    });
    if (!orderResult.success) {
      return { success: false, message: orderResult.message };
    }

    console.info('[checkout] idempotent_reuse', {
      userId,
      participantId: reusedParticipantId,
      orderId: state.snapshot.order_id,
      orderNumber: state.snapshot.order_number,
      paymentStatus: state.snapshot.payment_status,
    });

    return {
      success: true,
      courtesy_message: Number(state.snapshot.final_amount ?? 0) <= 0 ? 'Cortesia aplicada. Nenhum pagamento sera necessario.' : null,
      registration: state.snapshot,
    };
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
    p_payment_method: input.payment_method,
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

  const { error: participantLinkError } = await supabase
    .from('participants')
    .update({ user_id: userId, email: normalizedEmail })
    .eq('id', participantId);
  if (participantLinkError) return { success: false, message: participantLinkError.message };

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

  return {
    success: true,
    courtesy_message: Number(refreshedState.snapshot.final_amount ?? 0) <= 0 ? 'Cortesia aplicada. Nenhum pagamento sera necessario.' : null,
    registration: refreshedState.snapshot,
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

  const [{ data: participant, error: participantError }, { data: paymentData, error: paymentError }, { data: kitData, error: kitError }, { data: ticket }] = await Promise.all([
    supabase
      .from('participants')
      .select('id, event_id, full_name, cpf, registration_status, reservation_status, reservation_expires_at, created_at, shirt_type, shirt_size, ticket_categories(name), registration_batches(name), events(name)')
      .eq('id', participantId)
      .eq('user_id', user.id)
      .single(),
    supabase.rpc('get_participant_payment_details', { p_participant_id: participantId }),
    supabase.rpc('get_participant_kit_items', { p_participant_id: participantId }),
    supabase.from('tickets').select('token, status').eq('participant_id', participantId).maybeSingle(),
  ]);

  if (participantError) return { success: false, message: participantError.message };
  if (paymentError) return { success: false, message: paymentError.message };
  if (kitError) return { success: false, message: kitError.message };

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
      kit_items: (kitData ?? []).map((item: Record<string, unknown>) => ({
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
