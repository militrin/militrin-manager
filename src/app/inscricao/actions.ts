'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { calculateAge, isValidCpf, removeCpfMask } from '@/lib/validation/registration';
import { FakePaymentProvider } from '@/lib/payments/fake-provider';
import { toISODateFromBR } from '@/lib/utils/date';
import { formatDateBR } from '@/lib/utils/date';
import { getEmailProvider } from '@/lib/email/fake-provider';

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
  user_id?: string;
};

type SignupActionResult =
  | {
      success: true;
      user_id: string;
      email: string;
      email_confirmation_required: boolean;
      authenticated: boolean;
      profile_warning?: string;
    }
  | {
      success: false;
      message: string;
      code?: string;
    };

const paymentProvider = new FakePaymentProvider();
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
  if (normalized.includes('already registered')) {
    return 'E-mail já cadastrado.';
  }
  if (normalized.includes('invalid email')) {
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
  if (normalized.includes('already registered')) return 'already_registered';
  if (normalized.includes('invalid email')) return 'invalid_email';
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
  const { error } = await params.supabase.rpc('upsert_customer_profile', {
    p_user_id: params.userId,
    p_full_name: params.fullName,
    p_cpf: params.cpf ?? null,
    p_birth_date: params.birthDate ?? null,
    p_gender: params.gender ?? null,
    p_phone: params.phone ?? null,
    p_email: params.email,
    p_city: params.city ?? null,
    p_loyalty_tier_id: params.loyaltyTierId ?? null,
    p_loyalty_override: false,
    p_loyalty_override_reason: null,
    p_show_in_participant_list: true,
    p_allow_friend_requests: true,
    p_profile_visibility: 'participants',
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
    ?? params.email.split('@')[0]
    ?? 'Participante',
  ).trim();

  const cpf = String(profile?.cpf ?? params.fallback?.cpf ?? '').replace(/\D/g, '') || null;
  const birthDate = normalizeBirthDateInput(String(profile?.birth_date ?? params.fallback?.birth_date ?? ''));
  const gender = String(profile?.gender ?? params.fallback?.gender ?? '').trim() || null;
  const phone = String(profile?.phone ?? params.fallback?.phone ?? '').replace(/\D/g, '') || null;
  const city = String(profile?.city ?? params.fallback?.city ?? '').trim() || null;
  const email = normalizeEmail(profile?.email ? String(profile.email) : params.email);

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
    return { success: true, authenticated: false };
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
    return { success: false, message: ensuredProfile.message };
  }

  const { data: profileData, error: profileError } = await supabase.rpc('get_customer_profile', {
    p_user_id: user.id,
  });
  if (profileError) {
    return { success: false, message: profileError.message };
  }

  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;

  return {
    success: true,
    authenticated: true,
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
          email: profile.email ? String(profile.email) : user.email ?? '',
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

export async function signInPublicAccountAction(input: { email: string; password: string }) {
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

    if (!ensuredProfile.success) {
      return { success: false, code: 'profile_error', message: ensuredProfile.message };
    }

    return {
      success: true,
      user_id: data.user.id,
      email: data.user.email ?? normalized,
      profile_warning: ensuredProfile.warning ?? null,
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
      return { success: false, code: 'profile_error', message: ensuredProfile.message };
    }

    if (ensuredProfile.warning) {
      profileWarning = ensuredProfile.warning;
    }
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

  let userId = input.user_id ?? null;
  if (!userId) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  }
  if (!userId) {
    return { success: false, message: 'Entre na sua conta para continuar a inscricao.' };
  }

  const cpf = removeCpfMask(input.cpf);
  const birthDateIso = toISODateFromBR(input.birth_date);
  if (!isValidCpf(cpf)) return { success: false, message: 'CPF invalido.' };
  if (!birthDateIso) return { success: false, message: 'Informe uma data válida no formato dd/MM/aaaa.' };

  const age = calculateAge(input.birth_date);
  if (age < 18) return { success: false, message: 'A inscricao exige idade minima de 18 anos.' };

  const { error: profileError } = await supabase.rpc('upsert_customer_profile', {
    p_user_id: userId,
    p_full_name: input.full_name.trim(),
    p_cpf: cpf,
    p_birth_date: birthDateIso,
    p_gender: input.gender || null,
    p_phone: input.phone.replace(/\D/g, ''),
    p_email: normalizedEmail,
    p_city: input.city?.trim() || null,
    p_loyalty_tier_id: null,
    p_loyalty_override: false,
    p_loyalty_override_reason: null,
    p_show_in_participant_list: true,
    p_allow_friend_requests: true,
    p_profile_visibility: 'participants',
  });
  if (profileError) return { success: false, message: profileError.message };

  const duplicateCheck = await checkPublicCpfAction({ event_id: input.event_id, cpf });
  if (!duplicateCheck.success) return duplicateCheck;

  const { data, error } = await supabase.rpc('create_registration', {
    p_full_name: input.full_name.trim(),
    p_cpf: cpf,
    p_birth_date: birthDateIso,
    p_gender: input.gender,
    p_phone: input.phone.replace(/\D/g, ''),
    p_email: normalizedEmail,
    p_city: input.city?.trim() || null,
    p_shirt_type: input.shirt_type?.trim() || null,
    p_shirt_size: input.shirt_size?.trim() || null,
    p_registration_status: 'pending',
    p_notes: input.notes?.trim() || null,
    p_payment_method: input.payment_method,
    p_payment_status: 'pending',
    p_event_id: input.event_id,
    p_coupon_code: input.coupon_code?.trim() || null,
    p_ticket_category_id: input.ticket_category_id,
  });

  if (error) return { success: false, message: error.message };

  const created = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!created?.participant_id) {
    return { success: false, message: 'Nao foi possivel criar a inscricao.' };
  }

  const participantId = String(created.participant_id);

  const { error: participantLinkError } = await supabase
    .from('participants')
    .update({ user_id: userId, email: normalizedEmail })
    .eq('id', participantId);
  if (participantLinkError) return { success: false, message: participantLinkError.message };

  const [{ data: paymentData, error: paymentError }, { data: participantData, error: participantError }, { data: kitData, error: kitError }] = await Promise.all([
    supabase.rpc('get_participant_payment_details', { p_participant_id: participantId }),
    supabase
      .from('participants')
      .select('id, event_id, full_name, registration_status, reservation_status, reservation_expires_at, shirt_type, shirt_size, email, ticket_categories(name), registration_batches(name)')
      .eq('id', participantId)
      .single(),
    supabase.rpc('get_participant_kit_items', { p_participant_id: participantId }),
  ]);

  if (paymentError) return { success: false, message: paymentError.message };
  if (participantError) return { success: false, message: participantError.message };
  if (kitError) return { success: false, message: kitError.message };

  const paymentRow = (Array.isArray(paymentData) ? paymentData[0] : paymentData) as Record<string, unknown> | null;
  if (!paymentRow) return { success: false, message: 'Pagamento nao encontrado apos criar inscricao.' };

  const isCourtesyOrZero = Number(paymentRow.final_amount ?? 0) <= 0 || String(paymentRow.payment_status ?? 'pending') === 'paid';
  const orderResult = await syncOrderAndTicket({
    participantId,
    userId,
    shouldIssueTicket: isCourtesyOrZero,
  });
  if (!orderResult.success) {
    return { success: false, message: orderResult.message };
  }

  const [{ data: ticket }, { data: order }] = await Promise.all([
    supabase.from('tickets').select('token').eq('participant_id', participantId).maybeSingle(),
    supabase.from('orders').select('id, order_number, status').eq('participant_id', participantId).maybeSingle(),
  ]);

  try {
    await sendTransactionEmails({
      participantId,
      paymentStatus: String(paymentRow.payment_status ?? 'pending'),
      paymentMethod: paymentRow.payment_method ? String(paymentRow.payment_method) : null,
      finalAmount: Number(paymentRow.final_amount ?? 0),
      email: normalizedEmail,
      fullName: input.full_name,
    });
  } catch (mailError) {
    console.warn('Falha ao enviar e-mail transacional:', mailError);
  }

  return {
    success: true,
    courtesy_message: Number(paymentRow.final_amount ?? 0) <= 0 ? 'Cortesia aplicada. Nenhum pagamento sera necessario.' : null,
    registration: {
      participant_id: participantId,
      payment_id: String(paymentRow.payment_id ?? ''),
      final_amount: Number(paymentRow.final_amount ?? 0),
      payment_status: String(paymentRow.payment_status ?? 'pending'),
      expires_at: paymentRow.expires_at ? String(paymentRow.expires_at) : null,
      event_id: String(participantData.event_id ?? input.event_id),
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
  const supabase = await createServerSupabaseClient();

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

  const { data: participant } = await supabase
    .from('participants')
    .select('email, full_name')
    .eq('id', participantId)
    .maybeSingle();

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

  return { success: true, payment: mapPayment(row) };
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
