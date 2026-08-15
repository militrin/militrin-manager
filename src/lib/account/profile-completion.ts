import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isValidCpf } from '@/lib/validation/registration';

export type ProfileCompletionStatus = {
  exists: boolean;
  isComplete: boolean;
  missingFields: string[];
  mustChangePassword: boolean;
  mustCompleteProfile: boolean;
  profile: Record<string, unknown> | null;
  error: string | null;
};

function hasText(value: unknown) {
  return String(value ?? '').trim().length > 0;
}

function hasValidCpf(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 && isValidCpf(digits);
}

function hasValidBirthDate(value: unknown) {
  const normalized = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized);
}

function hasValidPhone(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10;
}

function hasValidEmail(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.includes('@') && normalized.includes('.');
}

function getMissingRequiredProfileFields(profile: Record<string, unknown> | null, authEmail: string | null) {
  const missingEmail = !hasValidEmail(authEmail);

  if (!profile) {
    return [
      'full_name',
      'cpf',
      'birth_date',
      'phone',
      'city',
      missingEmail ? 'email' : null,
    ].filter(Boolean) as string[];
  }

  return [
    !hasText(profile.full_name) ? 'full_name' : null,
    !hasValidCpf(profile.cpf) ? 'cpf' : null,
    !hasValidBirthDate(profile.birth_date) ? 'birth_date' : null,
    !hasValidPhone(profile.phone) ? 'phone' : null,
    !hasText(profile.city) ? 'city' : null,
    missingEmail ? 'email' : null,
  ].filter(Boolean) as string[];
}

export async function getProfileCompletionStatus(userId: string, authEmailInput?: string | null): Promise<ProfileCompletionStatus> {
  const supabase = await createServerSupabaseClient();

  let authEmail = authEmailInput ?? null;
  if (!authEmail) {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    if (currentUser?.id === userId) {
      authEmail = currentUser.email ?? null;
    }
  }

  let profileData: Record<string, unknown> | null = null;
  let profileError: string | null = null;

  const rpcResult = await supabase.rpc('get_customer_profile', {
    p_user_id: userId,
  });

  if (!rpcResult.error) {
    profileData = (Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data) as Record<string, unknown> | null;
  } else {
    profileError = rpcResult.error.message;

    // Fallback for environments where RPC may be unavailable.
    const selectAttempts = [
      'user_id, full_name, cpf, birth_date, gender, phone, city',
    ];

    for (const selectExpr of selectAttempts) {
      const { data, error } = await supabase
        .from('customer_profiles')
        .select(selectExpr)
        .eq('user_id', userId)
        .maybeSingle();

      if (!error) {
        profileData = (data ?? null) as Record<string, unknown> | null;
        profileError = null;
        break;
      }
    }
  }

  if (profileError) {
    return {
      exists: false,
      isComplete: false,
      missingFields: [],
      mustChangePassword: false,
      mustCompleteProfile: false,
      profile: null,
      error: profileError,
    };
  }

  const profile = { ...(profileData ?? {}) } as Record<string, unknown>;

  // Optional augmentation from table columns if policy allows.
  let flagsRow: Record<string, unknown> | null = null;
  const flagsSelectAttempts = [
    'user_id, account_status, must_change_password, must_complete_profile',
    'user_id, must_change_password, must_complete_profile',
    'user_id, account_status',
    'user_id',
  ];

  for (const selectExpr of flagsSelectAttempts) {
    const { data, error } = await supabase
      .from('customer_profiles')
      .select(selectExpr)
      .eq('user_id', userId)
      .maybeSingle();

    if (!error) {
      flagsRow = (data ?? null) as Record<string, unknown> | null;
      break;
    }
  }

  if (flagsRow) {
    const row = flagsRow as Record<string, unknown>;
    if (row.user_id !== undefined) profile.user_id = row.user_id;
    if (row.account_status !== undefined) profile.account_status = row.account_status;
    if (row.must_change_password !== undefined) profile.must_change_password = row.must_change_password;
    if (row.must_complete_profile !== undefined) profile.must_complete_profile = row.must_complete_profile;
  }

  const normalizedProfile = Object.keys(profile).length > 0 ? profile : null;
  const missingFields = getMissingRequiredProfileFields(normalizedProfile, authEmail);

  let mustChangePassword = false;
  let mustCompleteProfile = false;
  let accountStatus: string | null = null;

  if (flagsRow) {
    const row = flagsRow as Record<string, unknown>;
    mustChangePassword = Boolean(row.must_change_password);
    mustCompleteProfile = Boolean(row.must_complete_profile);
    accountStatus = row.account_status ? String(row.account_status) : null;
  }

  const isBlocked = accountStatus === 'blocked';

  const exists = Boolean(normalizedProfile?.user_id) || normalizedProfile !== null;
  const isComplete = exists && missingFields.length === 0 && !mustChangePassword && !mustCompleteProfile && !isBlocked;

  return {
    exists,
    isComplete,
    missingFields,
    mustChangePassword,
    mustCompleteProfile,
    profile: normalizedProfile,
    error: null,
  };
}
