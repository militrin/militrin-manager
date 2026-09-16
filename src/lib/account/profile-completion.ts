import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { validateFirstAccessProfile } from '@/lib/account/first-access-validation';

export type ProfileCompletionStatus = {
  exists: boolean;
  isComplete: boolean;
  missingFields: string[];
  mustChangePassword: boolean;
  mustCompleteProfile: boolean;
  profile: Record<string, unknown> | null;
  error: string | null;
};

function getMissingRequiredProfileFields(profile: Record<string, unknown> | null, authEmail: string | null) {
  const validation = validateFirstAccessProfile({ ...(profile ?? {}), email: authEmail });
  return Object.keys(validation.fieldErrors);
}

export type CustomerProfileRowResult = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

export const getCustomerProfileRow = cache(async (userId: string | null | undefined): Promise<CustomerProfileRowResult> => {
  if (!userId) return { data: null, error: null };

  const supabase = await createServerSupabaseClient();
  const rpcResult = await supabase.rpc('get_customer_profile', {
    p_user_id: userId,
  });

  if (!rpcResult.error) {
    const data = (Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data) as Record<string, unknown> | null;
    return { data: data ?? null, error: null };
  }

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
      return { data: (data ?? null) as Record<string, unknown> | null, error: null };
    }
  }

  return { data: null, error: { message: rpcResult.error.message } };
});

async function loadProfileCompletionStatus(userId: string, authEmailInput?: string | null): Promise<ProfileCompletionStatus> {
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

  const profileResult = await getCustomerProfileRow(userId);
  const profileData = profileResult.data;
  const profileError = profileResult.error?.message ?? null;

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

export const getProfileCompletionStatus = cache(loadProfileCompletionStatus);
