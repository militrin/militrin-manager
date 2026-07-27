type SupabaseLike = {
  rpc: (fn: string, args?: Record<string, unknown>) => unknown;
};

type UpsertCustomerProfileInput = {
  userId: string;
  fullName: string | null;
  cpf: string | null;
  birthDate: string | null;
  gender: string | null;
  phone: string | null;
  email?: string | null;
  city: string | null;
  loyaltyTierId?: string | null;
  loyaltyOverride?: boolean;
  loyaltyOverrideReason?: string | null;
  showInParticipantList?: boolean;
  allowFriendRequests?: boolean;
  profileVisibility?: string | null;
};

function isFunctionSignatureError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('could not find the function public.upsert_customer_profile')
    || (normalized.includes('function public.upsert_customer_profile') && normalized.includes('does not exist'));
}

export async function upsertCustomerProfileCompat(
  supabase: SupabaseLike,
  input: UpsertCustomerProfileInput,
): Promise<{ error: { message: string } | null; mode: 'extended' | 'fallback' }> {
  const extendedPayload: Record<string, unknown> = {
    p_user_id: input.userId,
    p_full_name: input.fullName,
    p_cpf: input.cpf,
    p_birth_date: input.birthDate,
    p_gender: input.gender,
    p_phone: input.phone,
    p_city: input.city,
    p_loyalty_tier_id: input.loyaltyTierId ?? null,
    p_loyalty_override: input.loyaltyOverride ?? false,
    p_loyalty_override_reason: input.loyaltyOverrideReason ?? null,
    p_show_in_participant_list: input.showInParticipantList ?? true,
    p_allow_friend_requests: input.allowFriendRequests ?? true,
    p_profile_visibility: input.profileVisibility ?? 'participants',
  };

  if (input.email !== undefined && input.email !== null) {
    extendedPayload.p_email = input.email;
  }

  const extendedResult = (await supabase.rpc('upsert_customer_profile', extendedPayload)) as {
    error: { message: string } | null;
  };
  if (!extendedResult.error) {
    return { error: null, mode: 'extended' };
  }

  if (!isFunctionSignatureError(extendedResult.error.message)) {
    return { error: extendedResult.error, mode: 'extended' };
  }

  const fallbackPayload = {
    p_user_id: input.userId,
    p_full_name: input.fullName,
    p_cpf: input.cpf,
    p_birth_date: input.birthDate,
    p_gender: input.gender,
    p_phone: input.phone,
    p_city: input.city,
  };

  const fallbackResult = (await supabase.rpc('upsert_customer_profile', fallbackPayload)) as {
    error: { message: string } | null;
  };
  return { error: fallbackResult.error, mode: 'fallback' };
}
